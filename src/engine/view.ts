import type { Card, PowerKind } from "./cards";
import { cardValue } from "./cards";
import {
  canSnapNow,
  cardsInHand,
  currentPlayerId,
  handTotal,
  isSnapSuspended,
  knows,
  topDiscard,
} from "./engine";
import { type GameState, type LogEntry, type Phase, INITIAL_PEEKS } from "./types";

/**
 * A slot as one specific player is entitled to see it.
 * `card` is present ONLY when that viewer has legitimately seen it -
 * unknown cards are never serialized to the client at all.
 */
export type SlotView =
  | { state: "empty" }
  | { state: "hidden" }
  | { state: "known"; card: Card };

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
  score: number;
  lastRoundScore: number | null;
  slots: SlotView[];
  cardCount: number;
  /** Only populated once the round is revealed. */
  total: number | null;
  isYou: boolean;
  isCurrent: boolean;
  calledCabo: boolean;
  tookFinalTurn: boolean;
}

export type PendingView =
  | { kind: "none" }
  | { kind: "drawn"; from: "deck" | "discard"; card: Card | null }
  | {
      kind: "power";
      power: PowerKind;
      stage: "look" | "swap";
      looksRemaining: number;
      isYours: boolean;
    };

export interface GameView {
  phase: Phase;
  roundNumber: number;
  targetScore: number;
  youId: string;
  players: PlayerView[];
  currentPlayerId: string | null;
  deckCount: number;
  discardTop: Card | null;
  discardCount: number;
  pending: PendingView;
  pendingGive: { snapperId: string; toPlayerId: string; toSlot: number } | null;
  caboCallerId: string | null;
  snapOpen: boolean;
  snapSuspended: boolean;
  canSnap: boolean;
  initialPeeksLeft: number;
  log: LogEntry[];
  revealAll: boolean;
  yourTurn: boolean;
}

function slotView(s: GameState, viewerId: string, card: Card | null, reveal: boolean): SlotView {
  if (card === null) return { state: "empty" };
  if (reveal || knows(s, viewerId, card.id)) return { state: "known", card };
  return { state: "hidden" };
}

export function buildView(s: GameState, viewerId: string): GameView {
  const reveal = s.revealAll;
  const current = currentPlayerId(s);

  const players: PlayerView[] = s.players.map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.isHost,
    score: p.score,
    lastRoundScore: p.lastRoundScore,
    slots: p.slots.map((c) => slotView(s, viewerId, c, reveal)),
    cardCount: cardsInHand(p),
    total: reveal ? handTotal(p) : null,
    isYou: p.id === viewerId,
    isCurrent: p.id === current,
    calledCabo: s.caboCallerId === p.id,
    tookFinalTurn: s.finalTurnsTaken.includes(p.id),
  }));

  let pending: PendingView = { kind: "none" };
  if (s.pending.kind === "drawn") {
    // The drawn card is visible ONLY to the player holding it.
    pending = {
      kind: "drawn",
      from: s.pending.from,
      card: current === viewerId ? s.pending.card : null,
    };
  } else if (s.pending.kind === "power") {
    pending = {
      kind: "power",
      power: s.pending.power,
      stage: s.pending.stage,
      looksRemaining: s.pending.looksRemaining,
      isYours: current === viewerId,
    };
  }

  return {
    phase: s.phase,
    roundNumber: s.roundNumber,
    targetScore: s.targetScore,
    youId: viewerId,
    players,
    currentPlayerId: current,
    deckCount: s.deck.length,
    discardTop: topDiscard(s),
    discardCount: s.discard.length,
    pending,
    pendingGive: s.pendingGive,
    caboCallerId: s.caboCallerId,
    snapOpen: s.snapOpen,
    snapSuspended: isSnapSuspended(s),
    canSnap: canSnapNow(s),
    initialPeeksLeft: Math.max(0, INITIAL_PEEKS - (s.initialPeeks[viewerId] ?? 0)),
    log: s.log.filter((l) => !l.private || l.private.includes(viewerId)),
    revealAll: reveal,
    yourTurn: current === viewerId && s.caboCallerId !== viewerId,
  };
}

/** Sanity guard used in tests: no view may leak an unseen card. */
export function viewLeaks(s: GameState, viewerId: string): string[] {
  const leaks: string[] = [];
  if (s.revealAll) return leaks;
  const view = buildView(s, viewerId);
  for (const p of view.players) {
    for (const [i, slot] of p.slots.entries()) {
      if (slot.state === "known" && !knows(s, viewerId, slot.card.id)) {
        leaks.push(`${p.name} slot ${i} leaked ${slot.card.id}`);
      }
    }
  }
  if (view.pending.kind === "drawn" && view.pending.card && view.currentPlayerId !== viewerId) {
    leaks.push("drawn card leaked");
  }
  return leaks;
}

export function viewTotal(view: GameView, playerId: string): number | null {
  const p = view.players.find((x) => x.id === playerId);
  if (!p) return null;
  return p.slots.reduce(
    (sum, s) => sum + (s.state === "known" ? cardValue(s.card) : 0),
    0,
  );
}
