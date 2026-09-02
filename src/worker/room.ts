import { DurableObject } from "cloudflare:workers";
import {
  addPlayer,
  applyAction,
  createGame,
  getPlayer,
  removePlayer,
  setConnected,
  turnIsStalled,
} from "../engine/engine";
import type { Action, GameState } from "../engine/types";
import { buildView } from "../engine/view";
import type { Env } from "./env";
import type { ClientMsg, ServerMsg, SocketMeta } from "./protocol";

/** How long a dropped player's turn is held before it is auto-played. */
const STALL_TIMEOUT_MS = 25_000;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function sanitizeName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const cleaned = s.replace(CONTROL_CHARS, "").trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : "Player";
}

function sanitizeId(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/**
 * One Durable Object per room key.
 *
 * This is the only place that ever holds the full deck. Clients receive a
 * per-player redacted view, so cards they have not earned the right to see
 * are never serialized to their socket at all.
 *
 * Because a Durable Object is single-threaded, snap races need no locking:
 * whichever snap message arrives first is simply processed first.
 */
export class GameRoom extends DurableObject<Env> {
  private game!: GameState;
  private roomKey = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<GameState>("game");
      this.roomKey = (await ctx.storage.get<string>("roomKey")) ?? "";
      if (saved) {
        this.game = saved;
      } else {
        const seed = new Uint32Array(1);
        crypto.getRandomValues(seed);
        this.game = createGame(seed[0] as number);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomKey = url.searchParams.get("room") ?? "";
    if (roomKey && this.roomKey !== roomKey) {
      this.roomKey = roomKey;
      await this.ctx.storage.put("roomKey", roomKey);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API: the room sleeps while idle without dropping sockets.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMsg;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      msg = JSON.parse(text) as ClientMsg;
    } catch {
      this.sendTo(ws, { t: "error", message: "Malformed message." });
      return;
    }

    switch (msg.t) {
      case "ping":
        this.sendTo(ws, { t: "pong" });
        return;

      case "join": {
        const playerId = sanitizeId(msg.playerId);
        const name = sanitizeName(msg.name);
        if (!playerId) {
          this.sendTo(ws, { t: "error", message: "Invalid player id." });
          return;
        }
        ws.serializeAttachment({ playerId, name } satisfies SocketMeta);

        const existing = getPlayer(this.game, playerId);
        if (existing) {
          this.game = setConnected(this.game, playerId, true);
          const p = getPlayer(this.game, playerId);
          if (p) p.name = name;
        } else {
          const result = addPlayer(this.game, playerId, name);
          if (!result.ok) {
            // Spectator: a round is already running, or the room is full.
            this.sendTo(ws, { t: "joined", playerId, roomKey: this.roomKey });
            this.sendTo(ws, { t: "error", message: result.error });
            this.sendTo(ws, {
              t: "state",
              view: buildView(this.game, playerId),
              roomKey: this.roomKey,
            });
            return;
          }
          this.game = result.state;
        }
        this.sendTo(ws, { t: "joined", playerId, roomKey: this.roomKey });
        await this.commit();
        return;
      }

      case "rename": {
        const meta = this.metaOf(ws);
        if (!meta) return;
        const name = sanitizeName(msg.name);
        const p = getPlayer(this.game, meta.playerId);
        if (p) p.name = name;
        ws.serializeAttachment({ ...meta, name } satisfies SocketMeta);
        await this.commit();
        return;
      }

      case "action": {
        const meta = this.metaOf(ws);
        if (!meta) {
          this.sendTo(ws, { t: "error", message: "Join the room first." });
          return;
        }
        const ca = msg.action;
        if (!ca || typeof ca !== "object" || typeof ca.type !== "string") {
          this.sendTo(ws, { t: "error", message: "Malformed action." });
          return;
        }
        // Only the host may deal a new round.
        if (ca.type === "startRound" || ca.type === "newGame") {
          const me = getPlayer(this.game, meta.playerId);
          if (!me?.isHost) {
            this.sendTo(ws, { t: "error", message: "Only the host can start a round." });
            return;
          }
        }
        // The authenticated id always overrides whatever the client sent,
        // so a client can never act on another player's behalf.
        const action = { ...ca, playerId: meta.playerId } as Action;
        const result = applyAction(this.game, action);
        if (!result.ok) {
          this.sendTo(ws, { t: "error", message: result.error });
          return;
        }
        this.game = result.state;
        await this.commit();
        return;
      }

      default:
        this.sendTo(ws, { t: "error", message: "Unknown message." });
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = this.metaOf(ws);
    if (!meta) return;
    // A player may have several tabs open; only drop them when the last one goes.
    const stillHere = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && this.metaOf(other)?.playerId === meta.playerId);
    if (stillHere) return;
    this.game = removePlayer(this.game, meta.playerId);
    await this.commit();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    if (turnIsStalled(this.game)) {
      const result = applyAction(this.game, { type: "forceAdvance" });
      if (result.ok) this.game = result.state;
    }
    await this.commit();
  }

  /* ------------------------------------------------------------------ */

  private metaOf(ws: WebSocket): SocketMeta | null {
    try {
      return (ws.deserializeAttachment() as SocketMeta | null) ?? null;
    } catch {
      return null;
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  /** Persist, push a fresh per-player view to everyone, and watch for stalls. */
  private async commit(): Promise<void> {
    await this.ctx.storage.put("game", this.game);
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      if (!meta) continue;
      this.sendTo(ws, {
        t: "state",
        view: buildView(this.game, meta.playerId),
        roomKey: this.roomKey,
      });
    }
    if (turnIsStalled(this.game)) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) {
        await this.ctx.storage.setAlarm(Date.now() + STALL_TIMEOUT_MS);
      }
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
