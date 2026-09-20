import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { POWER_LABEL, cardValue, powerOf } from "../engine/cards";
import { REVEAL_MS, type SlotRef, type SwapEvent } from "../engine/types";
import type { GameView, PlayerView, SlotView } from "../engine/view";
import { prettyKey } from "./App";
import { CardFace, PowerBadge, Slot } from "./CardFace";
import { isSoundEnabled, playSound, setSoundEnabled, type SoundKind } from "./sound";
import type { Room } from "./useRoom";

interface TableProps {
  room: Room;
  roomKey: string;
  onLeave: () => void;
  onShowRules: () => void;
}

/** What a tap on a card currently means. */
type Mode =
  | { m: "none" }
  | { m: "peek" }
  | { m: "swapDrawn" }
  | { m: "powerLook" }
  | { m: "powerSwap" }
  | { m: "snap" }
  | { m: "give" };

const sameRef = (a: SlotRef | null, b: SlotRef) =>
  !!a && a.playerId === b.playerId && a.slot === b.slot;

const swapKeyOf = (playerId: string, slot: number) => `${playerId}:${slot}`;

/** One card's half of a swap-flight: where it visually starts, relative to its resting slot. */
interface SwapLeg {
  key: string;
  dx: number;
  dy: number;
  /** false = pinned at the start offset (no transition yet); true = animating home. */
  settled: boolean;
}

/** Sound to play for a freshly-arrived log line, or null if it already has its own cue. */
function soundForLogText(text: string): SoundKind | null {
  if (/ SNAPS /.test(text)) return "snapHit";
  if (/ MISSES /.test(text)) return "snapMiss";
  if (/calls CABO/.test(text)) return "cabo";
  // A power-swap's own log line is already covered by the swap-flash animation/sound.
  if (/'s slot \d+ with .+'s slot \d+\.$/.test(text)) return null;
  if (/swaps into slot/.test(text)) return "discard";
  if (/discards/.test(text)) return "discard";
  if (/draws from the deck/.test(text)) return "draw";
  if (/takes .+ from the discard/.test(text)) return "draw";
  if (/looks at/.test(text)) return "power";
  return null;
}

export function Table({ room, roomKey, onLeave, onShowRules }: TableProps) {
  const { view, receivedAt, conn, error, clearError, send } = room;
  const [snapArmed, setSnapArmed] = useState(false);
  const [swapFirst, setSwapFirst] = useState<SlotRef | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [soundOn, setSoundOn] = useState(isSoundEnabled);
  const [flashSwap, setFlashSwap] = useState<SwapEvent | null>(null);
  const [flight, setFlight] = useState<SwapLeg[] | null>(null);
  const seenSwapId = useRef<number | null | undefined>(undefined);
  const seenLogId = useRef<number | null>(null);

  const toggleSound = () => {
    setSoundOn((on) => {
      setSoundEnabled(!on);
      return !on;
    });
  };

  // Flash the two swapped slots once, and fly each card across the table to
  // where the other one was - a real swap, not just a highlight.
  useEffect(() => {
    const swap = view?.lastSwap ?? null;
    if (seenSwapId.current === undefined) {
      seenSwapId.current = swap?.id ?? null;
      return;
    }
    if (!swap || swap.id === seenSwapId.current) return;
    seenSwapId.current = swap.id;
    playSound("swap");
    setFlashSwap(swap);
    const tFlash = setTimeout(() => setFlashSwap(null), 900);

    const keyA = swapKeyOf(swap.a.playerId, swap.a.slot);
    const keyB = swapKeyOf(swap.b.playerId, swap.b.slot);
    const elA = document.querySelector(`[data-swap-key="${CSS.escape(keyA)}"]`);
    const elB = document.querySelector(`[data-swap-key="${CSS.escape(keyB)}"]`);
    let raf1: number | undefined;
    let raf2: number | undefined;
    let tClear: number | undefined;
    if (elA && elB) {
      const rA = elA.getBoundingClientRect();
      const rB = elB.getBoundingClientRect();
      // Each card starts offset at the other's spot, then transitions to translate(0) -
      // i.e. it visually arrives home from wherever the other card was.
      setFlight([
        { key: keyA, dx: rB.left - rA.left, dy: rB.top - rA.top, settled: false },
        { key: keyB, dx: rA.left - rB.left, dy: rA.top - rB.top, settled: false },
      ]);
      // Two rAFs so the browser paints the start offset before the transition begins.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setFlight((f) => f && f.map((leg) => ({ ...leg, settled: true })));
        });
      });
      tClear = window.setTimeout(() => setFlight(null), 520);
    }
    return () => {
      clearTimeout(tFlash);
      if (raf1 !== undefined) cancelAnimationFrame(raf1);
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
      if (tClear !== undefined) clearTimeout(tClear);
    };
  }, [view?.lastSwap]);

  // Small sound cues for other actions, driven off new log lines so everyone
  // at the table hears the same things, not just whoever clicked.
  useEffect(() => {
    if (!view) return;
    const entries = view.log;
    if (entries.length === 0) return;
    const newestId = entries[entries.length - 1]!.id;
    if (seenLogId.current === null) {
      seenLogId.current = newestId;
      return;
    }
    if (newestId === seenLogId.current) return;
    const fresh = entries.filter((e) => e.id > (seenLogId.current as number));
    seenLogId.current = newestId;
    for (const entry of fresh) {
      const kind = soundForLogText(entry.text);
      if (kind) playSound(kind);
    }
  }, [view?.log]);

  // Disarm the snap button the moment the window shuts.
  useEffect(() => {
    if (!view?.canSnap) setSnapArmed(false);
  }, [view?.canSnap]);

  // Clear a half-finished swap whenever the power step changes.
  useEffect(() => {
    if (view?.pending.kind !== "power" || view.pending.stage !== "swap") setSwapFirst(null);
  }, [view?.pending]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 3200);
    return () => clearTimeout(t);
  }, [error, clearError]);

  // Memory mode: run the flip-back countdown locally so it is crisp, while the
  // server independently stops sending the card once the window closes.
  const counting =
    view?.players.some((p) =>
      p.slots.some((sl) => sl.state === "known" && sl.hidesInMs !== null),
    ) ?? false;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    setClock(Date.now());
    const id = window.setInterval(() => setClock(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [counting, receivedAt]);

  const mode: Mode = useMemo(() => {
    if (!view) return { m: "none" };
    if (view.pendingGive?.snapperId === view.youId) return { m: "give" };
    if (snapArmed && view.canSnap) return { m: "snap" };
    if (view.phase === "peek" && view.initialPeeksLeft > 0) return { m: "peek" };
    if (view.yourTurn && view.pending.kind === "drawn") return { m: "swapDrawn" };
    if (view.yourTurn && view.pending.kind === "power") {
      return view.pending.stage === "look" ? { m: "powerLook" } : { m: "powerSwap" };
    }
    return { m: "none" };
  }, [view, snapArmed]);

  if (!view) {
    return (
      <div className="table-shell">
        <div className="center-msg">
          {conn === "closed" ? "Reconnecting to the room..." : "Joining the room..."}
        </div>
      </div>
    );
  }

  const elapsed = Math.max(0, clock - receivedAt);
  const liveSlot = (sl: SlotView): SlotView =>
    sl.state === "known" && sl.hidesInMs !== null && elapsed >= sl.hidesInMs
      ? { state: "hidden" }
      : sl;
  const livePlayers = view.players.map((p) => ({ ...p, slots: p.slots.map(liveSlot) }));

  const you = livePlayers.find((p) => p.isYou) ?? null;
  const others = livePlayers.filter((p) => !p.isYou);
  const shareUrl = `${location.origin}${location.pathname}?room=${prettyKey(roomKey)}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked - the key is on screen anyway */
    }
  };

  /* ---------------- tap handling ---------------- */

  const isSelectable = (owner: PlayerView, index: number): boolean => {
    const slot = owner.slots[index];
    if (!slot || slot.state === "empty") return false;
    switch (mode.m) {
      case "peek":
        return owner.isYou && slot.state === "hidden";
      case "swapDrawn":
        return owner.isYou;
      case "give":
        return owner.isYou;
      case "snap":
        // The Cabo caller is untouchable; your own last card cannot be shed.
        if (owner.calledCabo && !owner.isYou) return false;
        if (owner.isYou) return owner.cardCount > 1;
        return (you?.cardCount ?? 0) > 1;
      case "powerLook": {
        if (view.pending.kind !== "power") return false;
        if (view.pending.power === "peekOwn") return owner.isYou;
        if (view.pending.power === "spyOther") return !owner.isYou;
        return true;
      }
      case "powerSwap": {
        if (view.pending.kind !== "power") return false;
        if (owner.calledCabo) return false; // locked hand, either direction
        return true;
      }
      default:
        return false;
    }
  };

  const onSlotClick = (owner: PlayerView, index: number) => {
    const ref: SlotRef = { playerId: owner.id, slot: index };
    switch (mode.m) {
      case "peek":
        send({ type: "initialPeek", slot: index });
        return;
      case "swapDrawn":
        send({ type: "swapDrawn", slot: index });
        return;
      case "give":
        send({ type: "giveCard", slot: index });
        return;
      case "snap":
        setSnapArmed(false);
        if (owner.isYou) send({ type: "snapOwn", slot: index });
        else send({ type: "snapOther", target: ref });
        return;
      case "powerLook":
        send({ type: "powerLook", target: ref });
        return;
      case "powerSwap":
        if (!swapFirst) {
          setSwapFirst(ref);
        } else if (sameRef(swapFirst, ref)) {
          setSwapFirst(null);
        } else {
          send({ type: "powerSwap", a: swapFirst, b: ref });
          setSwapFirst(null);
        }
        return;
      default:
    }
  };

  /* ---------------- status line ---------------- */

  const status = ((): string => {
    if (view.phase === "lobby") return "Waiting for the host to deal.";
    if (view.phase === "peek") {
      return view.initialPeeksLeft > 0
        ? `Peek at ${view.initialPeeksLeft} more of your own cards.`
        : view.memoryMode
          ? "Waiting for everyone else. Your cards flip back 3 seconds after play begins."
          : "Waiting for everyone else to finish peeking.";
    }
    if (view.phase === "roundEnd") return "Round over.";
    if (view.phase === "gameEnd") return "Game over.";

    if (view.pendingGive) {
      const snapper = view.players.find((p) => p.id === view.pendingGive?.snapperId);
      const victim = view.players.find((p) => p.id === view.pendingGive?.toPlayerId);
      return view.pendingGive.snapperId === view.youId
        ? `You snapped ${victim?.name}. Pick a card to hand over.`
        : `${snapper?.name} is choosing a card to hand to ${victim?.name}.`;
    }

    if (mode.m === "snap") return "SNAP armed - tap the card you are calling.";

    if (view.yourTurn) {
      if (view.pending.kind === "none") return "Your turn - draw, take the discard, or call Cabo.";
      if (view.pending.kind === "drawn") {
        return view.pending.from === "discard"
          ? "Tap one of your cards to swap this in."
          : "Swap it into a slot, or discard it.";
      }
      if (view.pending.kind === "power") {
        if (view.pending.stage === "look") {
          return view.pending.looksRemaining > 1
            ? `Tap ${view.pending.looksRemaining} cards to look at.`
            : "Tap a card to look at.";
        }
        return swapFirst ? "Now tap the second card." : "Tap two cards to swap, or skip.";
      }
    }
    const cur = view.players.find((p) => p.id === view.currentPlayerId);
    return `${cur?.name ?? "Someone"} is playing...`;
  })();

  const drawnCard = view.pending.kind === "drawn" ? view.pending.card : null;
  const drawnFromDiscard = view.pending.kind === "drawn" && view.pending.from === "discard";
  const isSwapping = (playerId: string, slot: number) =>
    !!flashSwap &&
    ((flashSwap.a.playerId === playerId && flashSwap.a.slot === slot) ||
      (flashSwap.b.playerId === playerId && flashSwap.b.slot === slot));
  const flightStyleFor = (playerId: string, slot: number): CSSProperties | undefined => {
    const leg = flight?.find((l) => l.key === swapKeyOf(playerId, slot));
    if (!leg) return undefined;
    return {
      transform: leg.settled ? "translate(0, 0)" : `translate(${leg.dx}px, ${leg.dy}px)`,
      transition: leg.settled ? "transform 0.46s cubic-bezier(0.2, 0.7, 0.2, 1)" : "none",
      position: "relative",
      zIndex: 6,
    };
  };

  return (
    <div className="table-shell">
      <header className="topbar">
        <button className="room-key" onClick={copyLink} title="Copy the invite link">
          <span className="room-key-label">ROOM</span>
          <span className="room-key-value">{prettyKey(roomKey)}</span>
          <span className="room-key-copy">{copied ? "copied" : "copy link"}</span>
        </button>
        <div className="topbar-right">
          <span className={`conn conn-${conn}`} title={conn}>
            {conn === "open" ? "live" : conn === "connecting" ? "connecting" : "offline"}
          </span>
          <button
            className="btn btn-ghost"
            onClick={toggleSound}
            title={soundOn ? "Mute sound effects" : "Unmute sound effects"}
          >
            {soundOn ? "Sound: on" : "Sound: off"}
          </button>
          <button className="btn btn-ghost" onClick={() => setShowLog((v) => !v)}>Log</button>
          <button className="btn btn-ghost" onClick={onShowRules}>Rules</button>
          <button className="btn btn-ghost" onClick={onLeave}>Leave</button>
        </div>
      </header>

      {error && <div className="toast toast-error">{error}</div>}

      <section className="opponents">
        {others.length === 0 && (
          <div className="waiting-hint">
            Share the room key and your friends can drop straight in.
            <code className="share-url">{shareUrl}</code>
          </div>
        )}
        {others.map((p) => (
          <HandPanel
            key={p.id}
            player={p}
            view={view}
            small
            elapsed={elapsed}
            isSelectable={isSelectable}
            onSlotClick={onSlotClick}
            swapFirst={swapFirst}
            isSwapping={isSwapping}
            flightStyleFor={flightStyleFor}
          />
        ))}
      </section>

      <section className="middle">
        <div className="piles">
          <div className="pile">
            <div className="card card-back pile-card">
              <span className="card-back-mark">?</span>
            </div>
            <span className="pile-label">Deck - {view.deckCount}</span>
          </div>
          <div className="pile">
            {view.discardTop ? (
              <div className="pile-card">
                <CardFace card={view.discardTop} />
              </div>
            ) : (
              <div className="slot slot-empty pile-card" />
            )}
            <span className="pile-label">
              Discard
              {view.discardTop && <> - snap {rankWord(view.discardTop.rank)}</>}
            </span>
          </div>
        </div>

        <div className="status-block">
          <p className="status">{status}</p>
          {!view.memoryMode && (
            <p className="assist-note">
              <strong>Assist mode</strong> - this is the dumb version, where you don&apos;t have to
              remember your cards. Everything you have seen stays face up.
            </p>
          )}
          {view.caboCallerId && view.phase === "playing" && (
            <p className="cabo-note">
              {view.players.find((p) => p.id === view.caboCallerId)?.name} called CABO - their hand is
              locked and completely safe. Everyone else gets one final turn.
            </p>
          )}
          {drawnCard && view.yourTurn && (
            <div className="drawn">
              <span className="drawn-label">{drawnFromDiscard ? "Taken" : "Drawn"}</span>
              <CardFace card={drawnCard} />
              <div className="drawn-meta">
                <strong>{cardValue(drawnCard)} points</strong>
                {!drawnFromDiscard && powerOf(drawnCard) && <PowerBadge card={drawnCard} />}
              </div>
            </div>
          )}
        </div>
      </section>

      {you && (
        <section className="you-area">
          <HandPanel
            player={you}
            view={view}
            elapsed={elapsed}
            isSelectable={isSelectable}
            onSlotClick={onSlotClick}
            swapFirst={swapFirst}
            isSwapping={isSwapping}
            flightStyleFor={flightStyleFor}
          />
        </section>
      )}

      <ActionBar
        view={view}
        you={you}
        mode={mode}
        snapArmed={snapArmed}
        setSnapArmed={setSnapArmed}
        send={send}
        swapFirst={swapFirst}
        cancelSwap={() => setSwapFirst(null)}
      />

      {showLog && (
        <aside className="log-panel">
          <header>
            <strong>Game log</strong>
            <button className="btn btn-ghost" onClick={() => setShowLog(false)}>close</button>
          </header>
          <ol>
            {view.log.slice().reverse().map((l) => (
              <li key={l.id} className={l.private ? "log-private" : ""}>{l.text}</li>
            ))}
          </ol>
        </aside>
      )}

      {(view.phase === "roundEnd" || view.phase === "gameEnd") && (
        <RoundOverlay view={view} you={you} send={send} />
      )}
    </div>
  );
}

function rankWord(rank: number): string {
  const names: Record<number, string> = {
    1: "an Ace", 11: "a Jack", 12: "a Queen", 13: "a King",
  };
  return names[rank] ?? `a ${rank}`;
}

/* ------------------------------------------------------------------ */

interface HandPanelProps {
  player: PlayerView;
  view: GameView;
  small?: boolean;
  elapsed: number;
  isSelectable: (p: PlayerView, i: number) => boolean;
  onSlotClick: (p: PlayerView, i: number) => void;
  swapFirst: SlotRef | null;
  isSwapping: (playerId: string, slot: number) => boolean;
  flightStyleFor: (playerId: string, slot: number) => CSSProperties | undefined;
}

function HandPanel({
  player,
  view,
  small,
  elapsed,
  isSelectable,
  onSlotClick,
  swapFirst,
  isSwapping,
  flightStyleFor,
}: HandPanelProps) {
  const locked = player.calledCabo;
  return (
    <div
      className={[
        "hand-panel",
        small ? "hand-panel-sm" : "hand-panel-you",
        player.isCurrent ? "is-current" : "",
        locked ? "is-locked" : "",
        !player.connected ? "is-away" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="hand-head">
        <span className="hand-name">
          {player.name}
          {player.isYou && <em> (you)</em>}
          {player.isHost && <span className="tag">host</span>}
        </span>
        <span className="hand-meta">
          <span className="score" title="Cumulative score">{player.score}</span>
          {locked && <span className="tag tag-cabo">CABO - safe</span>}
          {player.tookFinalTurn && !locked && <span className="tag">done</span>}
          {!player.connected && <span className="tag tag-away">away</span>}
        </span>
      </div>
      <div className="slots">
        {player.slots.map((slot, i) => (
          <Slot
            key={i}
            slot={slot}
            index={i}
            small={small}
            locked={locked && view.phase === "playing"}
            selectable={isSelectable(player, i)}
            selected={sameRef(swapFirst, { playerId: player.id, slot: i })}
            swapping={isSwapping(player.id, i)}
            swapKey={swapKeyOf(player.id, i)}
            flightStyle={flightStyleFor(player.id, i)}
            countdown={
              slot.state === "known" && slot.hidesInMs !== null
                ? Math.min(1, Math.max(0, slot.hidesInMs - elapsed) / REVEAL_MS)
                : null
            }
            onClick={() => onSlotClick(player, i)}
          />
        ))}
      </div>
      {view.revealAll && player.total !== null && (
        <div className="hand-total">
          hand {player.total}
          {player.lastRoundScore !== null && <> - scored {player.lastRoundScore}</>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface ActionBarProps {
  view: GameView;
  you: PlayerView | null;
  mode: Mode;
  snapArmed: boolean;
  setSnapArmed: (v: boolean) => void;
  send: Room["send"];
  swapFirst: SlotRef | null;
  cancelSwap: () => void;
}

function ActionBar({ view, you, mode, snapArmed, setSnapArmed, send, swapFirst, cancelSwap }: ActionBarProps) {
  const canStart =
    you?.isHost &&
    (view.phase === "lobby" || view.phase === "roundEnd") &&
    view.players.length >= 2;
  // The mode is a table-wide setting, so only between rounds and host only.
  const canSetMode =
    you?.isHost && (view.phase === "lobby" || view.phase === "roundEnd" || view.phase === "gameEnd");

  const pending = view.pending;
  const yourTurn = view.yourTurn && !view.pendingGive;

  return (
    <footer className="actionbar">
      <div className="actionbar-main">
        {canStart && (
          <button className="btn btn-primary" onClick={() => send({ type: "startRound" })}>
            {view.phase === "lobby" ? "Deal the round" : "Next round"}
          </button>
        )}
        {canSetMode && (
          <button
            className={`btn mode-toggle ${view.memoryMode ? "is-on" : "is-off"}`}
            onClick={() => send({ type: "setMemoryMode", on: !view.memoryMode })}
            title={
              view.memoryMode
                ? "Real Cabo: you get 3 seconds to look, then you must remember"
                : "Assist mode: everything you have seen stays face up"
            }
          >
            {view.memoryMode ? "Memory mode: ON" : "Memory mode: OFF"}
          </button>
        )}
        {you?.isHost === false && view.phase === "lobby" && (
          <span className="hint">Waiting for the host to deal.</span>
        )}
        {view.phase === "lobby" && view.players.length < 2 && you?.isHost && (
          <span className="hint">Need at least 2 players.</span>
        )}

        {yourTurn && pending.kind === "none" && view.phase === "playing" && (
          <>
            <button className="btn btn-primary" onClick={() => send({ type: "drawFromDeck" })}>
              Draw from deck
            </button>
            <button
              className="btn"
              onClick={() => send({ type: "takeDiscard" })}
              disabled={!view.discardTop}
            >
              Take the discard
            </button>
            <button className="btn btn-cabo" onClick={() => send({ type: "callCabo" })}>
              Call CABO
            </button>
          </>
        )}

        {yourTurn && pending.kind === "drawn" && pending.from === "deck" && (
          <>
            <span className="hint">Tap a slot to swap, or</span>
            <button className="btn" onClick={() => send({ type: "discardDrawn", usePower: false })}>
              Discard it
            </button>
            {pending.card && powerOf(pending.card) && (
              <button
                className="btn btn-primary"
                onClick={() => send({ type: "discardDrawn", usePower: true })}
              >
                Discard + use power
              </button>
            )}
          </>
        )}

        {yourTurn && pending.kind === "power" && (
          <>
            <span className="hint power-hint">{POWER_LABEL[pending.power]}</span>
            {pending.stage === "swap" && (
              <>
                {swapFirst && (
                  <button className="btn btn-ghost" onClick={cancelSwap}>Cancel selection</button>
                )}
                <button className="btn" onClick={() => send({ type: "powerSkip" })}>
                  Skip the swap
                </button>
              </>
            )}
          </>
        )}
      </div>

      <button
        className={`btn btn-snap ${snapArmed ? "is-armed" : ""}`}
        disabled={!view.canSnap || mode.m === "give"}
        onClick={() => setSnapArmed(!snapArmed)}
        title={
          view.canSnap
            ? "Arm a snap, then tap the card you are calling"
            : view.snapSuspended
              ? "Snapping is paused while a power resolves"
              : "The snap window is shut"
        }
      >
        {snapArmed ? "SNAP - pick a card" : "SNAP"}
      </button>
    </footer>
  );
}

/* ------------------------------------------------------------------ */

function RoundOverlay({ view, you, send }: { view: GameView; you: PlayerView | null; send: Room["send"] }) {
  const standings = view.players.slice().sort((a, b) => a.score - b.score);
  const over = view.phase === "gameEnd";
  const winner = standings[0];

  return (
    <div className="overlay">
      <div className="overlay-card">
        <h2>{over ? "Game over" : `Round ${view.roundNumber} complete`}</h2>
        {over && winner && (
          <p className="overlay-winner">
            {winner.name} wins with {winner.score} points.
          </p>
        )}
        <table className="standings">
          <thead>
            <tr><th>Player</th><th>Hand</th><th>Round</th><th>Total</th></tr>
          </thead>
          <tbody>
            {standings.map((p) => (
              <tr key={p.id} className={p.isYou ? "is-you" : ""}>
                <td>
                  {p.name}
                  {p.calledCabo && <span className="tag tag-cabo">called</span>}
                </td>
                <td>{p.total ?? "-"}</td>
                <td>{p.lastRoundScore ?? "-"}</td>
                <td><strong>{p.score}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="overlay-note">
          {over
            ? `Someone crossed ${view.targetScore}. Lowest total wins.`
            : `First to cross ${view.targetScore} loses. Land on exactly ${view.targetScore} and you drop to 50.`}
        </p>
        {you?.isHost ? (
          <button
            className="btn btn-primary btn-lg"
            onClick={() => send(over ? { type: "newGame" } : { type: "startRound" })}
          >
            {over ? "Start a new game" : "Deal the next round"}
          </button>
        ) : (
          <p className="hint">Waiting for the host.</p>
        )}
      </div>
    </div>
  );
}
