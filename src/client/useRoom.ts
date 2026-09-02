import { useCallback, useEffect, useRef, useState } from "react";
import type { GameView } from "../engine/view";
import type { ClientAction, ClientMsg, ServerMsg } from "../worker/protocol";

export type ConnState = "connecting" | "open" | "closed";

/**
 * Durable per-room identity so a refresh reconnects you to your own seat.
 * `?seat=` lets you open several tabs as different players while testing.
 */
function identityFor(roomKey: string): string {
  const seat = new URLSearchParams(location.search).get("seat") ?? "default";
  const key = `cabo:pid:${roomKey}:${seat}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export function loadName(): string {
  return localStorage.getItem("cabo:name") ?? "";
}

export function saveName(name: string): void {
  localStorage.setItem("cabo:name", name);
}

export interface Room {
  view: GameView | null;
  conn: ConnState;
  error: string | null;
  clearError: () => void;
  send: (action: ClientAction) => void;
  playerId: string | null;
}

export function useRoom(roomKey: string | null, name: string): Room {
  const [view, setView] = useState<GameView | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const retry = useRef(0);
  const alive = useRef(true);
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (!roomKey) return;
    alive.current = true;
    let timer: number | undefined;
    let heartbeat: number | undefined;

    const connect = () => {
      if (!alive.current) return;
      setConn("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomKey)}`);
      socket.current = ws;

      ws.onopen = () => {
        if (!alive.current) return;
        retry.current = 0;
        setConn("open");
        const id = identityFor(roomKey);
        setPlayerId(id);
        const join: ClientMsg = { t: "join", playerId: id, name: nameRef.current || "Player" };
        ws.send(JSON.stringify(join));
        // Keeps intermediaries from closing an idle socket.
        heartbeat = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" } satisfies ClientMsg));
        }, 30_000);
      };

      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data as string) as ServerMsg;
        } catch {
          return;
        }
        if (msg.t === "state") setView(msg.view);
        else if (msg.t === "joined") setPlayerId(msg.playerId);
        else if (msg.t === "error") setError(msg.message);
      };

      ws.onclose = () => {
        window.clearInterval(heartbeat);
        if (!alive.current) return;
        setConn("closed");
        // Exponential backoff, capped, so a sleeping room wakes cleanly.
        const delay = Math.min(500 * 2 ** retry.current, 8000);
        retry.current += 1;
        timer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      socket.current?.close();
      socket.current = null;
    };
  }, [roomKey]);

  const send = useCallback((action: ClientAction) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Not connected - reconnecting...");
      return;
    }
    ws.send(JSON.stringify({ t: "action", action } satisfies ClientMsg));
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { view, conn, error, clearError, send, playerId };
}
