import type { SlotRef } from "../engine/types";
import type { GameView } from "../engine/view";

/**
 * Actions as the client may express them - deliberately WITHOUT a playerId.
 * The room injects the authenticated id, so a client cannot act as anyone else.
 */
export type ClientAction =
  | { type: "startRound" }
  | { type: "initialPeek"; slot: number }
  | { type: "drawFromDeck" }
  | { type: "takeDiscard" }
  | { type: "swapDrawn"; slot: number }
  | { type: "discardDrawn"; usePower: boolean }
  | { type: "powerLook"; target: SlotRef }
  | { type: "powerSwap"; a: SlotRef; b: SlotRef }
  | { type: "powerSkip" }
  | { type: "callCabo" }
  | { type: "snapOwn"; slot: number }
  | { type: "snapOther"; target: SlotRef }
  | { type: "giveCard"; slot: number }
  | { type: "newGame" };

export type ClientMsg =
  | { t: "join"; playerId: string; name: string }
  | { t: "action"; action: ClientAction }
  | { t: "rename"; name: string }
  | { t: "ping" };

export type ServerMsg =
  | { t: "joined"; playerId: string; roomKey: string }
  | { t: "state"; view: GameView; roomKey: string }
  | { t: "error"; message: string }
  | { t: "pong" };

/** Attached to each socket so we know who is on the other end after hibernation. */
export interface SocketMeta {
  playerId: string;
  name: string;
}

const ROOM_WORDS = [
  "PLUM", "CROW", "MINT", "JADE", "RUST", "SAGE", "OPAL", "FERN",
  "MOSS", "CLAY", "DUSK", "TIDE", "KILN", "WISP", "LOOM", "REEF",
];

export function generateRoomKey(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const word = ROOM_WORDS[(bytes[0] as number) % ROOM_WORDS.length] as string;
  const digits = String(((bytes[1] as number) << 8 | (bytes[2] as number)) % 10000).padStart(4, "0");
  return `${word}-${digits}`;
}

/** Room keys are case- and punctuation-insensitive so they're easy to share. */
export function normalizeRoomKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}
