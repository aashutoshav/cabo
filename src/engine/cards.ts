/**
 * Card model for Cabo (house rules).
 *
 * Values: A=1, 2-10 face, J=11, Q=12, black K=13, RED K = -1.
 * Powers fire only when a drawn card is discarded without being kept.
 */

export type Suit = "S" | "H" | "D" | "C";
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export interface Card {
  /** Stable unique id per physical card, e.g. "KH". */
  id: string;
  rank: Rank;
  suit: Suit;
}

export const SUITS: Suit[] = ["S", "H", "D", "C"];
export const RANKS: Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

const RANK_LABEL: Record<Rank, string> = {
  1: "A", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
  8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K",
};

export const SUIT_SYMBOL: Record<Suit, string> = {
  S: "♠", H: "♥", D: "♦", C: "♣",
};

export function isRed(suit: Suit): boolean {
  return suit === "H" || suit === "D";
}

/** Red kings are the -1 scoring cards and carry NO power. */
export function isRedKing(card: Card): boolean {
  return card.rank === 13 && isRed(card.suit);
}

export function cardValue(card: Card): number {
  return isRedKing(card) ? -1 : card.rank;
}

export function cardLabel(card: Card): string {
  return `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}`;
}

export function cardName(card: Card): string {
  return `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]} (${cardValue(card)})`;
}

export type PowerKind =
  | "peekOwn" // 7, 8   - look at one of your own
  | "spyOther" // 9, 10  - look at one of an opponent's
  | "blindSwap" // J      - trade one of yours for one of an opponent's, unseen
  | "look1swap2" // Q      - look at any 1 on the board, then swap any 2 on the board
  | "look2swap2"; // black K - look at any 2 on the board, then swap any 2 on the board

export function powerOf(card: Card): PowerKind | null {
  switch (card.rank) {
    case 7:
    case 8:
      return "peekOwn";
    case 9:
    case 10:
      return "spyOther";
    case 11:
      return "blindSwap";
    case 12:
      return "look1swap2";
    case 13:
      return isRedKing(card) ? null : "look2swap2";
    default:
      return null;
  }
}

export const POWER_LABEL: Record<PowerKind, string> = {
  peekOwn: "Peek - look at one of your own cards",
  spyOther: "Spy - look at one opponent card",
  blindSwap: "Blind swap - trade one of yours for one of theirs, unseen",
  look1swap2: "Look at any 1 card, then swap any 2 cards",
  look2swap2: "Look at any 2 cards, then swap any 2 cards",
};

/** How many cards this power lets you look at before any swap. */
export function lookCount(power: PowerKind): number {
  switch (power) {
    case "peekOwn":
    case "spyOther":
    case "look1swap2":
      return 1;
    case "look2swap2":
      return 2;
    case "blindSwap":
      return 0;
  }
}

/** Whether this power ends with a swap step. */
export function hasSwapStep(power: PowerKind): boolean {
  return power === "blindSwap" || power === "look1swap2" || power === "look2swap2";
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${RANK_LABEL[rank]}${suit}`, rank, suit });
    }
  }
  return deck;
}

/** Deterministic PRNG so games are reproducible in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, non-mutating. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
