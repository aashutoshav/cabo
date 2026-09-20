import { describe, expect, it } from "vitest";
import { buildDeck, cardValue, powerOf, type Card } from "./cards";
import {
  addPlayer,
  applyAction,
  cardsInHand,
  createGame,
  currentPlayerId,
  handTotal,
  knows,
  nextRevealExpiry,
  startRound,
} from "./engine";
import type { Action, ApplyResult, GameState } from "./types";
import { buildView, viewLeaks } from "./view";

const DECK = buildDeck();
/** Look up a physical card by label, e.g. C("KH") is the red king of hearts. */
function C(id: string): Card {
  const card = DECK.find((c) => c.id === id);
  if (!card) throw new Error(`no card ${id}`);
  return { ...card };
}

function ok(r: ApplyResult): GameState {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.state;
}
function err(r: ApplyResult): string {
  if (r.ok) throw new Error("expected failure, but action succeeded");
  return r.error;
}
function act(s: GameState, a: Action, now?: number): GameState {
  return ok(applyAction(s, a, now));
}
/** Card ids a player has on record as having seen. */
function known(s: GameState, id: string): string[] {
  return Object.keys(s.knowledge[id] ?? {});
}

/** Build a mid-round state with exact hands, for precise rule tests. */
function table(
  hands: Record<string, (Card | null)[]>,
  opts: { top?: Card; deck?: Card[]; caboCaller?: string; knowAll?: boolean } = {},
): GameState {
  let s = createGame(1);
  for (const name of Object.keys(hands)) s = ok(addPlayer(s, name, name));
  s.phase = "playing";
  s.roundNumber = 1;
  s.snapOpen = true;
  s.turnOrder = Object.keys(hands);
  s.turnIndex = 0;
  for (const p of s.players) {
    p.slots = (hands[p.id] as (Card | null)[]).map((c) => (c ? { ...c } : null));
  }
  s.discard = [opts.top ?? C("2C")];
  s.deck = (opts.deck ?? [C("3D"), C("4D"), C("5D"), C("6D")]).map((c) => ({ ...c }));
  s.caboCallerId = opts.caboCaller ?? null;
  if (opts.knowAll) {
    for (const p of s.players) {
      s.knowledge[p.id] = Object.fromEntries(
        s.players.flatMap((q) =>
          q.slots.filter((c): c is Card => !!c).map((c) => [c.id, 0] as const),
        ),
      );
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */

describe("card values", () => {
  it("scores red kings as -1 and black kings as 13", () => {
    expect(cardValue(C("KH"))).toBe(-1);
    expect(cardValue(C("KD"))).toBe(-1);
    expect(cardValue(C("KS"))).toBe(13);
    expect(cardValue(C("KC"))).toBe(13);
  });

  it("scores the rest at face value", () => {
    expect(cardValue(C("AS"))).toBe(1);
    expect(cardValue(C("10H"))).toBe(10);
    expect(cardValue(C("JS"))).toBe(11);
    expect(cardValue(C("QS"))).toBe(12);
  });

  it("uses a standard 52-card deck with unique ids", () => {
    expect(DECK).toHaveLength(52);
    expect(new Set(DECK.map((c) => c.id)).size).toBe(52);
  });
});

describe("powers", () => {
  it("maps each rank to the agreed power", () => {
    expect(powerOf(C("7S"))).toBe("peekOwn");
    expect(powerOf(C("8S"))).toBe("peekOwn");
    expect(powerOf(C("9S"))).toBe("spyOther");
    expect(powerOf(C("10S"))).toBe("spyOther");
    expect(powerOf(C("JS"))).toBe("blindSwap");
    expect(powerOf(C("QS"))).toBe("look1swap2");
    expect(powerOf(C("KS"))).toBe("look2swap2");
    expect(powerOf(C("KC"))).toBe("look2swap2");
  });

  it("gives red kings no power at all", () => {
    expect(powerOf(C("KH"))).toBeNull();
    expect(powerOf(C("KD"))).toBeNull();
  });

  it("gives plain low cards no power", () => {
    for (const id of ["AS", "2S", "3S", "4S", "5S", "6S"]) {
      expect(powerOf(C(id))).toBeNull();
    }
  });
});

describe("setup", () => {
  it("deals 4 cards each and flips one to the discard", () => {
    let s = createGame(42);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s = ok(startRound(s));
    expect(s.phase).toBe("peek");
    for (const p of s.players) expect(cardsInHand(p)).toBe(4);
    expect(s.discard).toHaveLength(1);
    expect(s.deck).toHaveLength(52 - 8 - 1);
  });

  it("requires exactly two initial peeks from everyone before play starts", () => {
    let s = createGame(42);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s = ok(startRound(s));

    s = act(s, { type: "initialPeek", playerId: "a", slot: 0 });
    s = act(s, { type: "initialPeek", playerId: "a", slot: 1 });
    expect(err(applyAction(s, { type: "initialPeek", playerId: "a", slot: 2 }))).toMatch(/already peeked/i);
    expect(s.phase).toBe("peek");

    s = act(s, { type: "initialPeek", playerId: "b", slot: 0 });
    s = act(s, { type: "initialPeek", playerId: "b", slot: 3 });
    expect(s.phase).toBe("playing");
    expect(s.snapOpen).toBe(true);
    expect(known(s, "a")).toHaveLength(2);
  });
});

describe("turn actions", () => {
  it("swaps a drawn card in and discards the replaced one", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("AS")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    expect(s.snapOpen).toBe(false); // starting a turn shuts the window
    s = act(s, { type: "swapDrawn", playerId: "a", slot: 0 });
    expect(s.players[0]!.slots[0]!.id).toBe("AS");
    expect(s.discard.at(-1)!.id).toBe("9C");
    expect(s.snapOpen).toBe(true);
    expect(currentPlayerId(s)).toBe("b");
  });

  it("forbids re-discarding a card taken from the discard pile", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"),
    });
    s = act(s, { type: "takeDiscard", playerId: "a" });
    expect(err(applyAction(s, { type: "discardDrawn", playerId: "a", usePower: true }))).toMatch(
      /must be swapped/i,
    );
    s = act(s, { type: "swapDrawn", playerId: "a", slot: 1 });
    expect(s.players[0]!.slots[1]!.id).toBe("7D");
  });

  it("rejects actions from a player whose turn it is not", () => {
    const s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] });
    expect(err(applyAction(s, { type: "drawFromDeck", playerId: "b" }))).toMatch(/not your turn/i);
  });

  it("refuses to refill a shed slot", () => {
    let s = table({ a: [C("9C"), null, C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("AS")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    expect(err(applyAction(s, { type: "swapDrawn", playerId: "a", slot: 1 }))).toMatch(/shed/i);
  });
});

describe("power resolution", () => {
  it("7 peeks at one of your own cards only", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("7D")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    expect(err(applyAction(s, { type: "powerLook", playerId: "a", target: { playerId: "b", slot: 0 } }))).toMatch(
      /your own/i,
    );
    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "a", slot: 2 } });
    expect(known(s, "a")).toContain("4S");
    expect(currentPlayerId(s)).toBe("b"); // no swap step, turn ends
  });

  it("9 spies one opponent card only", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("9D")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    expect(err(applyAction(s, { type: "powerLook", playerId: "a", target: { playerId: "a", slot: 0 } }))).toMatch(
      /opponent/i,
    );
    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "b", slot: 1 } });
    expect(known(s, "a")).toContain("3H");
  });

  it("J blind-swaps any two cards on the board, unseen", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("JD")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });

    // yours-for-theirs still works
    s = act(s, {
      type: "powerSwap", playerId: "a",
      a: { playerId: "a", slot: 0 }, b: { playerId: "b", slot: 0 },
    });
    expect(s.players[0]!.slots[0]!.id).toBe("2H");
    expect(s.players[1]!.slots[0]!.id).toBe("9C");
    // neither side learns the card they received
    expect(known(s, "a")).not.toContain("2H");
    // the swap itself is recorded for client-side animation
    expect(s.lastSwap).toEqual({
      id: expect.any(Number),
      a: { playerId: "a", slot: 0 },
      b: { playerId: "b", slot: 0 },
    });
  });

  it("J can also swap two of your own cards, or two opponents' cards", () => {
    let s = table(
      { a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")], c: [C("6C"), C("7C"), C("8C"), C("9S")] },
      { deck: [C("JD")] },
    );
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });

    // two of your own is no longer blocked
    s = act(s, {
      type: "powerSwap", playerId: "a",
      a: { playerId: "a", slot: 0 }, b: { playerId: "a", slot: 1 },
    });
    expect(s.players[0]!.slots[0]!.id).toBe("3S");
    expect(s.players[0]!.slots[1]!.id).toBe("9C");
  });

  it("Q looks at any one card then swaps any two on the board", () => {
    let s = table(
      { a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")], c: [C("6C"), C("7C"), C("8C"), C("9S")] },
      { deck: [C("QD")] },
    );
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    // must look before swapping
    expect(
      err(applyAction(s, {
        type: "powerSwap", playerId: "a",
        a: { playerId: "b", slot: 0 }, b: { playerId: "c", slot: 0 },
      })),
    ).toMatch(/still have cards to look at/i);

    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "b", slot: 2 } });
    expect(known(s, "a")).toContain("4H");
    // the swap need not involve the card looked at, or the actor
    s = act(s, {
      type: "powerSwap", playerId: "a",
      a: { playerId: "b", slot: 0 }, b: { playerId: "c", slot: 0 },
    });
    expect(s.players[1]!.slots[0]!.id).toBe("6C");
    expect(s.players[2]!.slots[0]!.id).toBe("2H");
  });

  it("black K looks at two cards then swaps any two, and the swap is optional", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("KS")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "b", slot: 0 } });
    // cannot look at the same slot twice
    expect(err(applyAction(s, { type: "powerLook", playerId: "a", target: { playerId: "b", slot: 0 } }))).toMatch(
      /already looked/i,
    );
    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "a", slot: 3 } });
    expect(known(s, "a")).toContain("2H");
    expect(known(s, "a")).toContain("5S");
    s = act(s, { type: "powerSkip", playerId: "a" });
    expect(currentPlayerId(s)).toBe("b");
  });

  it("gives a red king no power to use", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("KH")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    expect(s.pending.kind).toBe("none");
    expect(currentPlayerId(s)).toBe("b");
  });

  it("suspends snapping while a power resolves", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("2S"), C("4H"), C("5H")] }, {
      deck: [C("QD")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    expect(err(applyAction(s, { type: "snapOwn", playerId: "b", slot: 1 }))).toMatch(/snap window is closed/i);
  });
});

describe("snapping", () => {
  it("sheds the card permanently on a successful self-snap", () => {
    let s = table({ a: [C("7C"), C("3S"), C("4S"), C("5S")], b: [C("7H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"),
    });
    s = act(s, { type: "snapOwn", playerId: "b", slot: 0 });
    expect(s.players[1]!.slots[0]).toBeNull();
    expect(cardsInHand(s.players[1]!)).toBe(3);
    expect(s.discard.at(-1)!.id).toBe("7H");
  });

  it("hands a penalty card on a missed self-snap and keeps the card in place", () => {
    let s = table({ a: [C("7C"), C("3S"), C("4S"), C("5S")], b: [C("9H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"), deck: [C("AS")],
    });
    s = act(s, { type: "snapOwn", playerId: "b", slot: 0 });
    expect(s.players[1]!.slots[0]!.id).toBe("9H");
    expect(cardsInHand(s.players[1]!)).toBe(5);
    // everyone saw the flipped card
    expect(known(s, "a")).toContain("9H");
  });

  it("treats kings as matching by rank regardless of colour", () => {
    let s = table({ a: [C("KS"), C("3S"), C("4S"), C("5S")], b: [C("KH"), C("3H"), C("4H"), C("5H")] }, {
      top: C("KC"),
    });
    s = act(s, { type: "snapOwn", playerId: "b", slot: 0 });
    expect(s.players[1]!.slots[0]).toBeNull(); // legal, if self-destructive
  });

  it("allows chained snaps of the same rank", () => {
    let s = table({ a: [C("7C"), C("3S"), C("4S"), C("5S")], b: [C("7H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"),
    });
    s = act(s, { type: "snapOwn", playerId: "b", slot: 0 });
    s = act(s, { type: "snapOwn", playerId: "a", slot: 0 });
    expect(s.players[0]!.slots[0]).toBeNull();
  });

  it("never lets you snap away your last card", () => {
    const s = table({ a: [C("7C"), null, null, null], b: [C("7H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"),
    });
    expect(err(applyAction(s, { type: "snapOwn", playerId: "a", slot: 0 }))).toMatch(/last card/i);
  });

  it("moves an opponent snap into a give step, and the snapper picks the card", () => {
    let s = table({ a: [C("KS"), C("3S"), C("4S"), C("5S")], b: [C("7H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"),
    });
    s = act(s, { type: "snapOther", playerId: "a", target: { playerId: "b", slot: 0 } });
    expect(s.pendingGive).toEqual({ snapperId: "a", toPlayerId: "b", toSlot: 0 });
    // snapping is suspended until the give resolves
    expect(err(applyAction(s, { type: "snapOwn", playerId: "b", slot: 1 }))).toMatch(/closed/i);
    s = act(s, { type: "giveCard", playerId: "a", slot: 0 });
    expect(s.players[1]!.slots[0]!.id).toBe("KS"); // dumped the 13 on them
    expect(cardsInHand(s.players[0]!)).toBe(3);
    expect(cardsInHand(s.players[1]!)).toBe(4);
    expect(s.pendingGive).toBeNull();
  });

  it("penalises a missed opponent snap and leaves the target untouched", () => {
    let s = table({ a: [C("KS"), C("3S"), C("4S"), C("5S")], b: [C("9H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"), deck: [C("AS")],
    });
    s = act(s, { type: "snapOther", playerId: "a", target: { playerId: "b", slot: 0 } });
    expect(s.pendingGive).toBeNull();
    expect(cardsInHand(s.players[1]!)).toBe(4);
    expect(cardsInHand(s.players[0]!)).toBe(5);
  });

  it("requires a spare card before snapping an opponent", () => {
    const s = table({ a: [C("KS"), null, null, null], b: [C("7H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"),
    });
    expect(err(applyAction(s, { type: "snapOther", playerId: "a", target: { playerId: "b", slot: 0 } }))).toMatch(
      /spare card/i,
    );
  });

  it("refuses snaps once the window is shut", () => {
    let s = table({ a: [C("7C"), C("3S"), C("4S"), C("5S")], b: [C("7H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"), deck: [C("AS")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" }); // starting a turn closes it
    expect(err(applyAction(s, { type: "snapOwn", playerId: "b", slot: 0 }))).toMatch(/closed/i);
  });
});

describe("cabo caller immunity", () => {
  it("blocks blind swaps against the caller", () => {
    let s = table(
      { a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")], c: [C("6C"), C("7C"), C("8C"), C("9S")] },
      { deck: [C("JD")], caboCaller: "c" },
    );
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    expect(
      err(applyAction(s, {
        type: "powerSwap", playerId: "a",
        a: { playerId: "a", slot: 0 }, b: { playerId: "c", slot: 0 },
      })),
    ).toMatch(/locked/i);
  });

  it("blocks queen and king swaps against the caller in both directions", () => {
    let s = table(
      { a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")], c: [C("6C"), C("7C"), C("8C"), C("9S")] },
      { deck: [C("QD")], caboCaller: "c" },
    );
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "b", slot: 0 } });
    expect(
      err(applyAction(s, {
        type: "powerSwap", playerId: "a",
        a: { playerId: "c", slot: 0 }, b: { playerId: "b", slot: 0 },
      })),
    ).toMatch(/locked/i);
    expect(
      err(applyAction(s, {
        type: "powerSwap", playerId: "a",
        a: { playerId: "b", slot: 0 }, b: { playerId: "c", slot: 0 },
      })),
    ).toMatch(/locked/i);
  });

  it("blocks opponent snaps against the caller", () => {
    const s = table(
      { a: [C("7C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")], c: [C("7S"), C("7C"), C("8C"), C("9S")] },
      { top: C("7D"), caboCaller: "c" },
    );
    expect(err(applyAction(s, { type: "snapOther", playerId: "a", target: { playerId: "c", slot: 0 } }))).toMatch(
      /caller is safe/i,
    );
  });

  it("still lets the caller look at, and spy on, and snap other players", () => {
    let s = table(
      { a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("7H"), C("3H"), C("4H"), C("5H")], c: [C("7S"), C("2C"), C("8C"), C("9S")] },
      { top: C("7D"), caboCaller: "c" },
    );
    // the caller may self-snap to shed
    s = act(s, { type: "snapOwn", playerId: "c", slot: 0 });
    expect(s.players[2]!.slots[0]).toBeNull();
    // and may snap opponents, dumping a card on them
    s = act(s, { type: "snapOther", playerId: "c", target: { playerId: "b", slot: 0 } });
    s = act(s, { type: "giveCard", playerId: "c", slot: 3 });
    expect(s.players[1]!.slots[0]!.id).toBe("9S");
  });

  it("denies the caller any further turns", () => {
    const s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      caboCaller: "a",
    });
    expect(err(applyAction(s, { type: "drawFromDeck", playerId: "a" }))).toMatch(/locked/i);
  });

  it("gives every other player exactly one final turn, then ends the round", () => {
    let s = table(
      { a: [C("AS"), C("2S"), null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")], c: [C("8C"), C("8D"), C("8H"), C("8S")] },
      { deck: [C("3D"), C("4D"), C("5D"), C("6D")] },
    );
    s = act(s, { type: "callCabo", playerId: "a" });
    expect(currentPlayerId(s)).toBe("b");
    s = act(s, { type: "drawFromDeck", playerId: "b" });
    s = act(s, { type: "discardDrawn", playerId: "b", usePower: false });
    expect(currentPlayerId(s)).toBe("c");
    expect(s.phase).toBe("playing");
    s = act(s, { type: "drawFromDeck", playerId: "c" });
    s = act(s, { type: "discardDrawn", playerId: "c", usePower: false });
    expect(s.phase).toBe("roundEnd");
    expect(s.revealAll).toBe(true);
  });
});

describe("scoring", () => {
  function finish(hands: Record<string, (Card | null)[]>, caller: string): GameState {
    let s = table(hands, { deck: [C("3D"), C("4D"), C("5D"), C("6D"), C("7D"), C("8D")] });
    s.turnOrder = Object.keys(hands);
    s.turnIndex = s.turnOrder.indexOf(caller);
    s = act(s, { type: "callCabo", playerId: caller });
    // every other player burns their final turn
    while (s.phase === "playing") {
      const cur = currentPlayerId(s)!;
      s = act(s, { type: "drawFromDeck", playerId: cur });
      s = act(s, { type: "discardDrawn", playerId: cur, usePower: false });
    }
    return s;
  }
  const score = (s: GameState, id: string) => s.players.find((p) => p.id === id)!.lastRoundScore;

  it("zeroes the caller when they are strictly lowest", () => {
    const s = finish({ a: [C("AS"), C("2S"), null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")] }, "a");
    expect(score(s, "a")).toBe(0);
    expect(score(s, "b")).toBe(36);
  });

  it("lets a negative caller keep the negative instead of being rounded up to 0", () => {
    const s = finish({ a: [C("KH"), null, null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")] }, "a");
    expect(handTotal(s.players[0]!)).toBe(-1);
    expect(score(s, "a")).toBe(-1);
  });

  it("adds the 5-point penalty when the caller is beaten", () => {
    const s = finish({ a: [C("5S"), C("5D"), null, null], b: [C("AS"), C("2S"), null, null] }, "a");
    expect(score(s, "a")).toBe(10 + 5);
    expect(score(s, "b")).toBe(3);
  });

  it("gives the caller the win on a tie for lowest", () => {
    const s = finish({ a: [C("5S"), null, null, null], b: [C("5D"), null, null, null] }, "a");
    expect(score(s, "a")).toBe(0);
    expect(score(s, "b")).toBe(5);
  });

  it("halves a score that lands exactly on the target", () => {
    let s = table({ a: [C("AS"), null, null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")] }, {
      deck: [C("3D"), C("4D")],
    });
    s.players[1]!.score = 64; // 64 + 36 = exactly 100
    s = act(s, { type: "callCabo", playerId: "a" });
    while (s.phase === "playing") {
      const cur = currentPlayerId(s)!;
      s = act(s, { type: "drawFromDeck", playerId: cur });
      s = act(s, { type: "discardDrawn", playerId: cur, usePower: false });
    }
    expect(s.players[1]!.score).toBe(50);
    expect(s.phase).toBe("roundEnd"); // reset, so the game continues
  });

  it("ends the game once someone passes the target", () => {
    let s = table({ a: [C("AS"), null, null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")] }, {
      deck: [C("3D"), C("4D")],
    });
    s.players[1]!.score = 70; // 70 + 36 = 106
    s = act(s, { type: "callCabo", playerId: "a" });
    while (s.phase === "playing") {
      const cur = currentPlayerId(s)!;
      s = act(s, { type: "drawFromDeck", playerId: cur });
      s = act(s, { type: "discardDrawn", playerId: cur, usePower: false });
    }
    expect(s.phase).toBe("gameEnd");
  });
});

describe("hidden information", () => {
  it("never sends a card the viewer has not seen", () => {
    let s = createGame(7);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s = ok(startRound(s));
    s = act(s, { type: "initialPeek", playerId: "a", slot: 0 });
    s = act(s, { type: "initialPeek", playerId: "a", slot: 1 });
    s = act(s, { type: "initialPeek", playerId: "b", slot: 0 });
    s = act(s, { type: "initialPeek", playerId: "b", slot: 1 });

    expect(viewLeaks(s, "a")).toEqual([]);
    expect(viewLeaks(s, "b")).toEqual([]);

    const viewB = buildView(s, "b");
    const ana = viewB.players.find((p) => p.id === "a")!;
    expect(ana.slots.every((sl) => sl.state === "hidden")).toBe(true);
    const you = viewB.players.find((p) => p.id === "b")!;
    expect(you.slots.filter((sl) => sl.state === "known")).toHaveLength(2);
  });

  it("hides the drawn card from everyone but the drawer", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("AS")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    const mine = buildView(s, "a").pending;
    const theirs = buildView(s, "b").pending;
    expect(mine.kind === "drawn" && mine.card?.id).toBe("AS");
    expect(theirs.kind === "drawn" && theirs.card).toBeNull();
    expect(viewLeaks(s, "b")).toEqual([]);
  });

  it("keeps private log lines private", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [C("7D")],
    });
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    s = act(s, { type: "discardDrawn", playerId: "a", usePower: true });
    s = act(s, { type: "powerLook", playerId: "a", target: { playerId: "a", slot: 2 } });
    const aLog = buildView(s, "a").log.map((l) => l.text).join("\n");
    const bLog = buildView(s, "b").log.map((l) => l.text).join("\n");
    expect(aLog).toMatch(/You see your own slot 3/);
    expect(bLog).not.toMatch(/You see/);
  });

  it("reveals every hand once the round ends", () => {
    let s = table({ a: [C("AS"), null, null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")] }, {
      deck: [C("3D"), C("4D")],
    });
    s = act(s, { type: "callCabo", playerId: "a" });
    while (s.phase === "playing") {
      const cur = currentPlayerId(s)!;
      s = act(s, { type: "drawFromDeck", playerId: cur });
      s = act(s, { type: "discardDrawn", playerId: cur, usePower: false });
    }
    const view = buildView(s, "a");
    const ben = view.players.find((p) => p.id === "b")!;
    expect(ben.slots.every((sl) => sl.state === "known")).toBe(true);
    expect(ben.total).toBe(36);
  });
});

describe("deck exhaustion", () => {
  it("reshuffles the discard pile, keeping the top card", () => {
    let s = table({ a: [C("9C"), C("3S"), C("4S"), C("5S")], b: [C("2H"), C("3H"), C("4H"), C("5H")] }, {
      deck: [],
    });
    s.discard = [C("AS"), C("2S"), C("3C"), C("7D")];
    s = act(s, { type: "drawFromDeck", playerId: "a" });
    expect(s.discard).toHaveLength(1);
    expect(s.discard[0]!.id).toBe("7D");
    expect(s.deck.length).toBe(2); // 3 reshuffled, 1 drawn
  });
});

describe("memory mode", () => {
  const T0 = 1_000_000;

  /** A round in progress, where everyone peeked simultaneously at T0. */
  function peeked(memoryMode: boolean) {
    let s = createGame(7);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s.memoryMode = memoryMode;
    s = ok(startRound(s));
    for (const id of ["a", "b"]) {
      s = act(s, { type: "initialPeek", playerId: id, slot: 0 }, T0);
      s = act(s, { type: "initialPeek", playerId: id, slot: 1 }, T0);
    }
    if (s.phase !== "playing") throw new Error("expected play to have begun");
    return s;
  }

  it("is on by default - real Cabo, not the assisted version", () => {
    expect(createGame(1).memoryMode).toBe(true);
  });

  it("stops sending a peeked card once the 3 seconds lapse", () => {
    const s = peeked(true);
    const cardId = (s.players[0]!.slots[0] as Card).id;

    // Visible immediately...
    expect(knows(s, "a", cardId, T0)).toBe(true);
    expect(buildView(s, "a", T0).players[0]!.slots[0]!.state).toBe("known");

    // ...still visible just before the deadline...
    expect(knows(s, "a", cardId, T0 + 2999)).toBe(true);

    // ...and genuinely gone from the payload afterwards.
    expect(knows(s, "a", cardId, T0 + 3000)).toBe(false);
    const late = buildView(s, "a", T0 + 3001).players[0]!.slots[0]!;
    expect(late.state).toBe("hidden");
    expect(JSON.stringify(late)).not.toContain(cardId);
  });

  it("counts down the remaining reveal time for the client", () => {
    const s = peeked(true);
    const at1s = buildView(s, "a", T0 + 1000).players[0]!.slots[0]!;
    expect(at1s.state === "known" && at1s.hidesInMs).toBe(2000);
  });

  it("keeps sightings forever in assist mode", () => {
    const s = peeked(false);
    const cardId = (s.players[0]!.slots[0] as Card).id;
    expect(knows(s, "a", cardId, T0 + 10 * 60 * 1000)).toBe(true);
    const later = buildView(s, "a", T0 + 10 * 60 * 1000).players[0]!.slots[0]!;
    expect(later.state === "known" && later.hidesInMs).toBeNull();
  });

  it("leaks nothing after a sighting lapses", () => {
    const s = peeked(true);
    expect(viewLeaks(s, "a", T0 + 5000)).toEqual([]);
    expect(viewLeaks(s, "b", T0 + 5000)).toEqual([]);
  });

  it("expires a snap flip for the whole table", () => {
    let s = table({ a: [C("7C"), C("3S"), C("4S"), C("5S")], b: [C("9H"), C("3H"), C("4H"), C("5H")] }, {
      top: C("7D"), deck: [C("AS")],
    });
    s = act(s, { type: "snapOwn", playerId: "b", slot: 0 }, T0); // a miss - everyone sees 9H
    expect(knows(s, "a", "9H", T0)).toBe(true);
    expect(knows(s, "a", "9H", T0 + 3001)).toBe(false);
  });

  it("reports when the next sighting lapses so the room can re-push", () => {
    const s = peeked(true);
    expect(nextRevealExpiry(s, T0)).toBe(T0 + 3000);
    expect(nextRevealExpiry(s, T0 + 5000)).toBeNull();
  });

  it("ignores expiry at the end-of-round reveal", () => {
    let s = table({ a: [C("AS"), null, null, null], b: [C("9H"), C("9D"), C("9C"), C("9S")] }, {
      deck: [C("3D"), C("4D")],
    });
    s = act(s, { type: "callCabo", playerId: "a" }, T0);
    while (s.phase === "playing") {
      const cur = currentPlayerId(s)!;
      s = act(s, { type: "drawFromDeck", playerId: cur }, T0);
      s = act(s, { type: "discardDrawn", playerId: cur, usePower: false }, T0);
    }
    const view = buildView(s, "a", T0 + 60_000);
    expect(view.players.every((p) => p.slots.every((sl) => sl.state !== "hidden"))).toBe(true);
  });

  it("refuses a mode change mid-round", () => {
    const s = peeked(true);
    expect(err(applyAction(s, { type: "setMemoryMode", on: false }))).toMatch(/finish the round/i);
  });

  it("allows a mode change between rounds", () => {
    let s = createGame(3);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s = act(s, { type: "setMemoryMode", on: false });
    expect(s.memoryMode).toBe(false);
    s = ok(startRound(s));
    expect(s.memoryMode).toBe(false);
  });
});

describe("peek phase timing", () => {
  const T0 = 2_000_000;

  it("holds both peeked cards up until the whole table is ready", () => {
    let s = createGame(11);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s = ok(startRound(s));
    s = act(s, { type: "initialPeek", playerId: "a", slot: 0 }, T0);
    s = act(s, { type: "initialPeek", playerId: "a", slot: 1 }, T0);
    const cardId = (s.players[0]!.slots[0] as Card).id;

    // Ben is slow; Ana's cards must not lapse while the round has not begun.
    expect(s.phase).toBe("peek");
    expect(knows(s, "a", cardId, T0 + 60_000)).toBe(true);

    // Ben finishes much later - the clock starts for everyone at that moment.
    const START = T0 + 60_000;
    s = act(s, { type: "initialPeek", playerId: "b", slot: 0 }, START);
    s = act(s, { type: "initialPeek", playerId: "b", slot: 1 }, START);
    expect(s.phase).toBe("playing");
    expect(knows(s, "a", cardId, START + 2999)).toBe(true);
    expect(knows(s, "a", cardId, START + 3001)).toBe(false);
  });

  it("does not let an expired sighting unlock a third peek", () => {
    let s = createGame(11);
    s = ok(addPlayer(s, "a", "Ana"));
    s = ok(addPlayer(s, "b", "Ben"));
    s = ok(startRound(s));
    s = act(s, { type: "initialPeek", playerId: "a", slot: 0 }, T0);
    expect(err(applyAction(s, { type: "initialPeek", playerId: "a", slot: 0 }, T0 + 9999)))
      .toMatch(/already peeked/i);
  });
});
