import type { Card, PowerKind } from "./cards";

export type Phase = "lobby" | "peek" | "playing" | "roundEnd" | "gameEnd";

export interface SlotRef {
  playerId: string;
  slot: number;
}

export interface Player {
  id: string;
  name: string;
  connected: boolean;
  /** null = permanently shed (snapped away). Empty slots never slide or refill. */
  slots: (Card | null)[];
  /** Cumulative score across rounds. */
  score: number;
  /** Points taken in the round just scored, for the results screen. */
  lastRoundScore: number | null;
  isHost: boolean;
}

/** Turn-local state: what the current player still owes an action for. */
export type Pending =
  | { kind: "none" }
  /** A card taken from the discard pile MUST be swapped in - it cannot be re-discarded. */
  | { kind: "drawn"; card: Card; from: "deck" | "discard" }
  | {
      kind: "power";
      power: PowerKind;
      source: Card;
      /** Looks still owed before the swap step. */
      looksRemaining: number;
      stage: "look" | "swap";
      /** Slots already looked at during this resolution, so you cannot look twice. */
      looked: SlotRef[];
    };

/**
 * A successful opponent-snap leaves the snapper owing one of their own cards.
 * This is deliberately separate from `pending` because a snap happens out of turn.
 */
export interface PendingGive {
  snapperId: string;
  toPlayerId: string;
  toSlot: number;
}

export interface LogEntry {
  id: number;
  text: string;
  /** Player ids this entry is private to; undefined = public. */
  private?: string[];
}

export interface GameState {
  phase: Phase;
  players: Player[];
  /** Player ids in seating order. */
  turnOrder: string[];
  turnIndex: number;
  deck: Card[];
  /** Last element is the visible top card. */
  discard: Card[];
  pending: Pending;
  pendingGive: PendingGive | null;
  caboCallerId: string | null;
  /** Ids that have taken their single post-Cabo turn. */
  finalTurnsTaken: string[];
  /** Snap window: open from a card landing face up until the next turn starts. */
  snapOpen: boolean;
  /** Initial 2-card peeks used, per player. */
  initialPeeks: Record<string, number>;
  /** Card ids each player has legitimately seen. Drives per-player redaction. */
  knowledge: Record<string, string[]>;
  log: LogEntry[];
  nextLogId: number;
  roundNumber: number;
  targetScore: number;
  /** Set at round end so clients can reveal every hand. */
  revealAll: boolean;
  rngSeed: number;
}

export type Action =
  | { type: "startRound" }
  | { type: "initialPeek"; playerId: string; slot: number }
  | { type: "drawFromDeck"; playerId: string }
  | { type: "takeDiscard"; playerId: string }
  | { type: "swapDrawn"; playerId: string; slot: number }
  | { type: "discardDrawn"; playerId: string; usePower: boolean }
  | { type: "powerLook"; playerId: string; target: SlotRef }
  | { type: "powerSwap"; playerId: string; a: SlotRef; b: SlotRef }
  | { type: "powerSkip"; playerId: string }
  | { type: "callCabo"; playerId: string }
  | { type: "snapOwn"; playerId: string; slot: number }
  | { type: "snapOther"; playerId: string; target: SlotRef }
  | { type: "giveCard"; playerId: string; slot: number }
  | { type: "newGame" }
  /** Server-only: auto-play a stalled turn (e.g. the active player dropped). */
  | { type: "forceAdvance" };

export type ApplyResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };

export const HAND_SIZE = 4;
export const INITIAL_PEEKS = 2;
export const CABO_PENALTY = 5;
export const SNAP_PENALTY_CARDS = 1;
export const TARGET_SCORE = 100;
export const EXACT_TARGET_RESET = 50;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
