import {
  type Card,
  type PowerKind,
  buildDeck,
  cardLabel,
  cardName,
  cardValue,
  hasSwapStep,
  lookCount,
  mulberry32,
  powerOf,
  shuffle,
} from "./cards";
import {
  type Action,
  type ApplyResult,
  type GameState,
  type LogEntry,
  type Player,
  type SlotRef,
  CABO_PENALTY,
  EXACT_TARGET_RESET,
  HAND_SIZE,
  INITIAL_PEEKS,
  MAX_PLAYERS,
  REVEAL_MS,
  SNAP_PENALTY_CARDS,
  TARGET_SCORE,
} from "./types";

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const clone = <T,>(v: T): T => structuredClone(v);

function fail(error: string): ApplyResult {
  return { ok: false, error };
}

export function getPlayer(s: GameState, id: string): Player | undefined {
  return s.players.find((p) => p.id === id);
}

function mustPlayer(s: GameState, id: string): Player {
  const p = getPlayer(s, id);
  if (!p) throw new Error(`no such player: ${id}`);
  return p;
}

export function currentPlayerId(s: GameState): string | null {
  return s.turnOrder[s.turnIndex] ?? null;
}

export function cardsInHand(p: Player): number {
  return p.slots.filter((c) => c !== null).length;
}

export function handTotal(p: Player): number {
  return p.slots.reduce((sum, c) => sum + (c ? cardValue(c) : 0), 0);
}

export function topDiscard(s: GameState): Card | null {
  return s.discard[s.discard.length - 1] ?? null;
}

/** Snapping is suspended while a power resolves or a give is owed. */
export function isSnapSuspended(s: GameState): boolean {
  return s.pending.kind === "power" || s.pendingGive !== null;
}

export function canSnapNow(s: GameState): boolean {
  return s.phase === "playing" && s.snapOpen && !isSnapSuspended(s);
}

function learn(s: GameState, playerId: string, cardId: string, now: number): void {
  const known = s.knowledge[playerId];
  if (!known) s.knowledge[playerId] = { [cardId]: now };
  else known[cardId] = now;
}

/** A card flipped face up for a snap attempt is seen by the whole table. */
function learnAll(s: GameState, cardId: string, now: number): void {
  for (const p of s.players) learn(s, p.id, cardId, now);
}

/** Whether this player has seen the card at all this round, expiry aside. */
export function hasEverSeen(s: GameState, playerId: string, cardId: string): boolean {
  return s.knowledge[playerId]?.[cardId] !== undefined;
}

/**
 * In memory mode a sighting lapses after REVEAL_MS, and the card stops being
 * sent to that player at all. In assist mode sightings never lapse.
 */
export function knows(s: GameState, playerId: string, cardId: string, now: number): boolean {
  const seenAt = s.knowledge[playerId]?.[cardId];
  if (seenAt === undefined) return false;
  if (!s.memoryMode) return true;
  // Nothing lapses while the table is still peeking; the clock starts together.
  if (s.phase === "peek") return true;
  return now - seenAt < REVEAL_MS;
}

/** Milliseconds until this sighting lapses, or null if it never will. */
export function revealRemaining(
  s: GameState,
  playerId: string,
  cardId: string,
  now: number,
): number | null {
  if (!s.memoryMode) return null;
  const seenAt = s.knowledge[playerId]?.[cardId];
  if (seenAt === undefined) return null;
  if (s.phase === "peek") return null;
  return Math.max(0, seenAt + REVEAL_MS - now);
}

/**
 * When the next live sighting lapses, so the room can re-push views at exactly
 * the moment a card should flip back over.
 */
export function nextRevealExpiry(s: GameState, now: number): number | null {
  if (!s.memoryMode || s.phase === "peek") return null;
  let earliest: number | null = null;
  for (const seen of Object.values(s.knowledge)) {
    for (const seenAt of Object.values(seen)) {
      const at = seenAt + REVEAL_MS;
      if (at > now && (earliest === null || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

function log(s: GameState, text: string, priv?: string[]): void {
  const entry: LogEntry = { id: s.nextLogId++, text };
  if (priv) entry.private = priv;
  s.log.push(entry);
  if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
}

function slotAt(s: GameState, ref: SlotRef): Card | null | undefined {
  const p = getPlayer(s, ref.playerId);
  if (!p) return undefined;
  if (ref.slot < 0 || ref.slot >= p.slots.length) return undefined;
  return p.slots[ref.slot] ?? null;
}

function nextSeed(s: GameState): number {
  s.rngSeed = (Math.imul(s.rngSeed, 1664525) + 1013904223) >>> 0;
  return s.rngSeed;
}

function reshuffleIfNeeded(s: GameState): void {
  if (s.deck.length > 0) return;
  if (s.discard.length <= 1) return;
  const top = s.discard.pop() as Card;
  s.deck = shuffle(s.discard, mulberry32(nextSeed(s)));
  s.discard = [top];
  log(s, "Deck ran out - discard pile reshuffled into a new deck.");
}

/** Penalty cards fill the leftmost shed slot, else extend the hand. */
function placeInHand(p: Player, card: Card): number {
  const empty = p.slots.findIndex((c) => c === null);
  if (empty >= 0) {
    p.slots[empty] = card;
    return empty;
  }
  p.slots.push(card);
  return p.slots.length - 1;
}

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */

export function createGame(seed: number): GameState {
  return {
    phase: "lobby",
    players: [],
    turnOrder: [],
    turnIndex: 0,
    deck: [],
    discard: [],
    pending: { kind: "none" },
    pendingGive: null,
    caboCallerId: null,
    finalTurnsTaken: [],
    snapOpen: false,
    initialPeeks: {},
    knowledge: {},
    // Real Cabo by default: you look, then you remember.
    memoryMode: true,
    log: [],
    nextLogId: 1,
    roundNumber: 0,
    targetScore: TARGET_SCORE,
    revealAll: false,
    rngSeed: seed >>> 0,
  };
}

export function startRound(state: GameState): ApplyResult {
  const s = clone(state);
  if (s.players.length < 2) return fail("Need at least 2 players.");
  if (s.phase === "playing" || s.phase === "peek") return fail("Round already in progress.");
  if (s.phase === "gameEnd") return fail("Game is over.");

  s.roundNumber += 1;
  s.deck = shuffle(buildDeck(), mulberry32(nextSeed(s)));
  s.discard = [];
  s.pending = { kind: "none" };
  s.pendingGive = null;
  s.caboCallerId = null;
  s.finalTurnsTaken = [];
  s.snapOpen = false;
  s.revealAll = false;
  s.initialPeeks = {};
  s.knowledge = {};

  s.turnOrder = s.players.map((p) => p.id);
  // Rotate the starting player each round so the same person doesn't always lead.
  const start = (s.roundNumber - 1) % s.turnOrder.length;
  s.turnIndex = start;

  for (const p of s.players) {
    p.slots = [];
    p.lastRoundScore = null;
    s.initialPeeks[p.id] = 0;
    s.knowledge[p.id] = {};
    for (let i = 0; i < HAND_SIZE; i++) {
      p.slots.push(s.deck.pop() as Card);
    }
  }

  // One card flipped face up to start the discard pile.
  s.discard.push(s.deck.pop() as Card);
  s.phase = "peek";
  log(s, `--- Round ${s.roundNumber} ---`);
  log(s, `Everyone: peek at ${INITIAL_PEEKS} of your own cards.`);
  return { ok: true, state: s };
}

/* ------------------------------------------------------------------ *
 * turn flow
 * ------------------------------------------------------------------ */

function endRound(s: GameState): void {
  s.revealAll = true;
  s.snapOpen = false;
  s.pending = { kind: "none" };
  s.pendingGive = null;

  const totals = new Map<string, number>();
  for (const p of s.players) totals.set(p.id, handTotal(p));

  const callerId = s.caboCallerId;
  const callerTotal = callerId ? (totals.get(callerId) ?? 0) : null;

  // The Cabo caller wins ties: they are safe if no one is strictly below them.
  let callerWins = false;
  if (callerId && callerTotal !== null) {
    callerWins = s.players
      .filter((p) => p.id !== callerId)
      .every((p) => (totals.get(p.id) ?? 0) >= callerTotal);
  }

  for (const p of s.players) {
    const total = totals.get(p.id) ?? 0;
    let points: number;
    if (p.id === callerId) {
      // Lowest (or tied) caller scores 0 - but never worse than their real hand,
      // so a negative hand keeps its negative.
      points = callerWins ? Math.min(0, total) : total + CABO_PENALTY;
    } else {
      points = total;
    }
    p.lastRoundScore = points;
    p.score += points;
  }

  const lines = s.players
    .map((p) => `${p.name}: ${totals.get(p.id) ?? 0} -> ${p.lastRoundScore} pts`)
    .join(" | ");
  if (callerId) {
    const caller = mustPlayer(s, callerId);
    log(
      s,
      callerWins
        ? `${caller.name} called Cabo with ${callerTotal} and was lowest - scores ${caller.lastRoundScore}.`
        : `${caller.name} called Cabo with ${callerTotal} but was beaten - ${callerTotal} + ${CABO_PENALTY} penalty.`,
    );
  }
  log(s, lines);

  // Landing on exactly the target drops you to half; going past it ends the game.
  for (const p of s.players) {
    if (p.score === s.targetScore) {
      p.score = EXACT_TARGET_RESET;
      log(s, `${p.name} hit exactly ${s.targetScore} - score drops to ${EXACT_TARGET_RESET}.`);
    }
  }

  const busted = s.players.filter((p) => p.score >= s.targetScore);
  if (busted.length > 0) {
    s.phase = "gameEnd";
    const winner = s.players.reduce((best, p) => (p.score < best.score ? p : best), s.players[0] as Player);
    log(s, `Game over - ${busted.map((p) => p.name).join(", ")} crossed ${s.targetScore}.`);
    log(s, `${winner.name} wins with the lowest score (${winner.score}).`);
  } else {
    s.phase = "roundEnd";
  }
}

function advanceTurn(s: GameState): void {
  s.pending = { kind: "none" };
  const actor = currentPlayerId(s);

  if (s.caboCallerId) {
    if (actor && actor !== s.caboCallerId && !s.finalTurnsTaken.includes(actor)) {
      s.finalTurnsTaken.push(actor);
    }
    const remaining = s.turnOrder.filter(
      (id) => id !== s.caboCallerId && !s.finalTurnsTaken.includes(id),
    );
    if (remaining.length === 0) {
      endRound(s);
      return;
    }
    for (let k = 1; k <= s.turnOrder.length; k++) {
      const idx = (s.turnIndex + k) % s.turnOrder.length;
      const cand = s.turnOrder[idx];
      if (cand && cand !== s.caboCallerId && !s.finalTurnsTaken.includes(cand)) {
        s.turnIndex = idx;
        return;
      }
    }
    endRound(s);
    return;
  }

  // Normal rotation, skipping anyone who has dropped out.
  for (let k = 1; k <= s.turnOrder.length; k++) {
    const idx = (s.turnIndex + k) % s.turnOrder.length;
    const cand = s.turnOrder[idx];
    if (!cand) continue;
    const p = getPlayer(s, cand);
    if (p?.connected) {
      s.turnIndex = idx;
      return;
    }
  }
  // Nobody connected - leave the turn where it is and wait for a reconnect.
}

function requireTurn(s: GameState, playerId: string): string | null {
  if (s.phase !== "playing") return "Round is not in progress.";
  if (s.pendingGive) return "Waiting for a snap to be resolved.";
  if (currentPlayerId(s) !== playerId) return "Not your turn.";
  if (s.caboCallerId === playerId) return "You called Cabo - your hand is locked.";
  return null;
}

/* ------------------------------------------------------------------ *
 * powers
 * ------------------------------------------------------------------ */

function beginPower(s: GameState, actorId: string, card: Card, power: PowerKind): void {
  const looks = lookCount(power);
  s.pending = {
    kind: "power",
    power,
    source: card,
    looksRemaining: looks,
    stage: looks > 0 ? "look" : "swap",
    looked: [],
  };
  const actor = mustPlayer(s, actorId);
  log(s, `${actor.name} plays ${cardLabel(card)}.`);
  if (looks === 0 && !hasSwapStep(power)) advanceTurn(s);
}

function finishPower(s: GameState): void {
  advanceTurn(s);
}

/** Swap targets may never touch the Cabo caller's locked hand. */
function swapGuard(s: GameState, ref: SlotRef): string | null {
  if (s.caboCallerId && ref.playerId === s.caboCallerId) {
    return "The Cabo caller's hand is locked - you cannot swap their cards.";
  }
  const card = slotAt(s, ref);
  if (card === undefined) return "No such card slot.";
  if (card === null) return "That slot is empty.";
  return null;
}

function doSwap(s: GameState, a: SlotRef, b: SlotRef): void {
  const pa = mustPlayer(s, a.playerId);
  const pb = mustPlayer(s, b.playerId);
  const ca = pa.slots[a.slot] ?? null;
  const cb = pb.slots[b.slot] ?? null;
  pa.slots[a.slot] = cb;
  pb.slots[b.slot] = ca;
}

/* ------------------------------------------------------------------ *
 * reducer
 * ------------------------------------------------------------------ */

export function applyAction(
  state: GameState,
  action: Action,
  now: number = Date.now(),
): ApplyResult {
  const s = clone(state);

  switch (action.type) {
    /* ---------------- setup ---------------- */

    case "startRound":
      return startRound(state);

    case "setMemoryMode": {
      if (s.phase === "playing" || s.phase === "peek") {
        return fail("Finish the round before changing the mode.");
      }
      s.memoryMode = action.on;
      log(
        s,
        action.on
          ? "Memory mode ON - cards flip back after 3 seconds. Remember them."
          : "Memory mode OFF - assist mode. Everything you have seen stays face up.",
      );
      return { ok: true, state: s };
    }

    case "newGame": {
      if (s.phase === "playing" || s.phase === "peek") return fail("A round is in progress.");
      for (const p of s.players) {
        p.score = 0;
        p.lastRoundScore = null;
        p.slots = [];
      }
      s.phase = "lobby";
      s.roundNumber = 0;
      s.caboCallerId = null;
      s.finalTurnsTaken = [];
      s.snapOpen = false;
      s.revealAll = false;
      s.pending = { kind: "none" };
      s.pendingGive = null;
      s.log = [];
      log(s, "Scores reset - new game.");
      return startRound(s);
    }

    case "initialPeek": {
      if (s.phase !== "peek") return fail("Not the peek phase.");
      const p = getPlayer(s, action.playerId);
      if (!p) return fail("Unknown player.");
      const used = s.initialPeeks[action.playerId] ?? 0;
      if (used >= INITIAL_PEEKS) return fail(`You have already peeked at ${INITIAL_PEEKS} cards.`);
      const card = p.slots[action.slot];
      if (!card) return fail("No card in that slot.");
      if (hasEverSeen(s, action.playerId, card.id)) return fail("You already peeked at that card.");
      learn(s, action.playerId, card.id, now);
      s.initialPeeks[action.playerId] = used + 1;
      log(s, `You peeked at slot ${action.slot + 1}: ${cardName(card)}.`, [action.playerId]);

      const allDone = s.players.every((pl) => (s.initialPeeks[pl.id] ?? 0) >= INITIAL_PEEKS);
      if (allDone) {
        s.phase = "playing";
        s.snapOpen = true;
        // Everyone looked together, so everyone's clock starts together.
        for (const seen of Object.values(s.knowledge)) {
          for (const cardId of Object.keys(seen)) seen[cardId] = now;
        }
        const first = currentPlayerId(s);
        log(s, "Everyone has peeked. Play begins - snapping is live.");
        if (first) log(s, `${mustPlayer(s, first).name} goes first.`);
      }
      return { ok: true, state: s };
    }

    /* ---------------- turn actions ---------------- */

    case "drawFromDeck": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "none") return fail("Finish your current action first.");
      reshuffleIfNeeded(s);
      if (s.deck.length === 0) return fail("No cards left to draw.");
      const card = s.deck.pop() as Card;
      // Beginning a turn shuts the snap window on the previous discard.
      s.snapOpen = false;
      s.pending = { kind: "drawn", card, from: "deck" };
      learn(s, action.playerId, card.id, now);
      log(s, `${mustPlayer(s, action.playerId).name} draws from the deck.`);
      return { ok: true, state: s };
    }

    case "takeDiscard": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "none") return fail("Finish your current action first.");
      const top = topDiscard(s);
      if (!top) return fail("The discard pile is empty.");
      s.discard.pop();
      s.snapOpen = false;
      // A taken discard must be swapped in, and grants no power.
      s.pending = { kind: "drawn", card: top, from: "discard" };
      learn(s, action.playerId, top.id, now);
      log(s, `${mustPlayer(s, action.playerId).name} takes ${cardLabel(top)} from the discard.`);
      return { ok: true, state: s };
    }

    case "swapDrawn": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "drawn") return fail("You have no drawn card.");
      const p = mustPlayer(s, action.playerId);
      const outgoing = p.slots[action.slot];
      if (outgoing === undefined) return fail("No such slot.");
      if (outgoing === null) return fail("That slot was shed - you cannot fill it.");
      const incoming = s.pending.card;
      p.slots[action.slot] = incoming;
      s.discard.push(outgoing);
      learn(s, action.playerId, incoming.id, now);
      learnAll(s, outgoing.id, now);
      s.pending = { kind: "none" };
      s.snapOpen = true;
      log(s, `${p.name} swaps into slot ${action.slot + 1}, discarding ${cardLabel(outgoing)}.`);
      advanceTurn(s);
      return { ok: true, state: s };
    }

    case "discardDrawn": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "drawn") return fail("You have no drawn card.");
      if (s.pending.from === "discard") {
        return fail("A card taken from the discard pile must be swapped into your hand.");
      }
      const card = s.pending.card;
      s.discard.push(card);
      learnAll(s, card.id, now);
      s.snapOpen = true;
      const power = powerOf(card);
      const p = mustPlayer(s, action.playerId);
      log(s, `${p.name} discards ${cardLabel(card)}.`);

      if (action.usePower && power) {
        beginPower(s, action.playerId, card, power);
        return { ok: true, state: s };
      }
      s.pending = { kind: "none" };
      advanceTurn(s);
      return { ok: true, state: s };
    }

    case "powerLook": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      const pending = s.pending;
      if (pending.kind !== "power") return fail("No power to resolve.");
      if (pending.stage !== "look") return fail("Looking is done - make your swap.");
      const { power } = pending;
      const target = slotAt(s, action.target);
      if (target === undefined) return fail("No such card slot.");
      if (target === null) return fail("That slot is empty.");
      if (power === "peekOwn" && action.target.playerId !== action.playerId) {
        return fail("This power only looks at your own cards.");
      }
      if (power === "spyOther" && action.target.playerId === action.playerId) {
        return fail("This power only looks at an opponent's cards.");
      }
      const already = pending.looked.some(
        (r) => r.playerId === action.target.playerId && r.slot === action.target.slot,
      );
      if (already) return fail("You already looked at that card - pick another.");

      learn(s, action.playerId, target.id, now);
      pending.looked.push({ ...action.target });

      const actor = mustPlayer(s, action.playerId);
      const isSelf = action.target.playerId === action.playerId;
      const ownerName = mustPlayer(s, action.target.playerId).name;
      log(
        s,
        `You see ${isSelf ? "your own" : ownerName + "'s"} slot ${action.target.slot + 1}: ${cardName(target)}.`,
        [action.playerId],
      );
      log(
        s,
        `${actor.name} looks at ${isSelf ? "their own" : ownerName + "'s"} slot ${action.target.slot + 1}.`,
      );

      pending.looksRemaining -= 1;
      if (pending.looksRemaining > 0) return { ok: true, state: s };

      if (hasSwapStep(power)) {
        pending.stage = "swap";
        return { ok: true, state: s };
      }
      finishPower(s);
      return { ok: true, state: s };
    }

    case "powerSwap": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "power") return fail("No power to resolve.");
      if (s.pending.stage !== "swap") return fail("You still have cards to look at.");
      const { power } = s.pending;
      const { a, b } = action;
      if (a.playerId === b.playerId && a.slot === b.slot) return fail("Pick two different cards.");
      const ga = swapGuard(s, a);
      if (ga) return fail(ga);
      const gb = swapGuard(s, b);
      if (gb) return fail(gb);

      if (power === "blindSwap") {
        const mine = [a, b].filter((r) => r.playerId === action.playerId);
        const theirs = [a, b].filter((r) => r.playerId !== action.playerId);
        if (mine.length !== 1 || theirs.length !== 1) {
          return fail("A blind swap trades one of your cards for one of an opponent's.");
        }
      }

      doSwap(s, a, b);
      const pa = mustPlayer(s, a.playerId);
      const pb = mustPlayer(s, b.playerId);
      log(
        s,
        `${mustPlayer(s, action.playerId).name} swaps ${pa.name}'s slot ${a.slot + 1} with ${pb.name}'s slot ${b.slot + 1}.`,
      );
      finishPower(s);
      return { ok: true, state: s };
    }

    case "powerSkip": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "power") return fail("No power to resolve.");
      if (s.pending.stage !== "swap") return fail("You must finish looking first.");
      log(s, `${mustPlayer(s, action.playerId).name} declines the swap.`);
      finishPower(s);
      return { ok: true, state: s };
    }

    case "callCabo": {
      const err = requireTurn(s, action.playerId);
      if (err) return fail(err);
      if (s.pending.kind !== "none") return fail("Finish your current action first.");
      if (s.caboCallerId) return fail("Cabo has already been called.");
      s.caboCallerId = action.playerId;
      const p = mustPlayer(s, action.playerId);
      log(s, `${p.name} calls CABO! Everyone else gets one final turn.`);
      log(s, `${p.name}'s hand is locked and completely safe - no swaps, no snaps.`);
      advanceTurn(s);
      return { ok: true, state: s };
    }

    /* ---------------- snapping ---------------- */

    case "snapOwn": {
      if (!canSnapNow(s)) return fail("The snap window is closed.");
      const p = getPlayer(s, action.playerId);
      if (!p) return fail("Unknown player.");
      const card = p.slots[action.slot];
      if (card === undefined) return fail("No such slot.");
      if (card === null) return fail("That slot is already empty.");
      if (cardsInHand(p) <= 1) return fail("You cannot snap away your last card.");
      const top = topDiscard(s);
      if (!top) return fail("Nothing to snap onto.");

      learnAll(s, card.id, now);
      if (card.rank === top.rank) {
        p.slots[action.slot] = null;
        s.discard.push(card);
        s.snapOpen = true;
        log(s, `${p.name} SNAPS ${cardLabel(card)} - slot ${action.slot + 1} is gone for good.`);
      } else {
        log(s, `${p.name} snaps ${cardLabel(card)} and MISSES - takes a penalty card.`);
        for (let i = 0; i < SNAP_PENALTY_CARDS; i++) {
          reshuffleIfNeeded(s);
          const pen = s.deck.pop();
          if (pen) placeInHand(p, pen);
        }
      }
      return { ok: true, state: s };
    }

    case "snapOther": {
      if (!canSnapNow(s)) return fail("The snap window is closed.");
      const snapper = getPlayer(s, action.playerId);
      if (!snapper) return fail("Unknown player.");
      if (action.target.playerId === action.playerId) return fail("Use a self-snap for your own cards.");
      if (s.caboCallerId === action.target.playerId) {
        return fail("The Cabo caller is safe - you cannot snap their cards.");
      }
      if (cardsInHand(snapper) <= 1) {
        return fail("You need a spare card to give away before you can snap an opponent.");
      }
      const victim = getPlayer(s, action.target.playerId);
      if (!victim) return fail("Unknown target.");
      const card = victim.slots[action.target.slot];
      if (card === undefined) return fail("No such slot.");
      if (card === null) return fail("That slot is already empty.");
      const top = topDiscard(s);
      if (!top) return fail("Nothing to snap onto.");

      learnAll(s, card.id, now);
      if (card.rank === top.rank) {
        victim.slots[action.target.slot] = null;
        s.discard.push(card);
        s.snapOpen = true;
        s.pendingGive = {
          snapperId: action.playerId,
          toPlayerId: victim.id,
          toSlot: action.target.slot,
        };
        log(
          s,
          `${snapper.name} SNAPS ${victim.name}'s ${cardLabel(card)} - now choosing a card to hand over.`,
        );
      } else {
        log(
          s,
          `${snapper.name} snaps at ${victim.name}'s slot ${action.target.slot + 1} (${cardLabel(card)}) and MISSES - takes a penalty card.`,
        );
        for (let i = 0; i < SNAP_PENALTY_CARDS; i++) {
          reshuffleIfNeeded(s);
          const pen = s.deck.pop();
          if (pen) placeInHand(snapper, pen);
        }
      }
      return { ok: true, state: s };
    }

    case "giveCard": {
      if (!s.pendingGive) return fail("Nothing to give.");
      if (s.pendingGive.snapperId !== action.playerId) return fail("Not your card to give.");
      const snapper = mustPlayer(s, action.playerId);
      const card = snapper.slots[action.slot];
      if (card === undefined) return fail("No such slot.");
      if (card === null) return fail("That slot is empty.");
      const victim = mustPlayer(s, s.pendingGive.toPlayerId);
      snapper.slots[action.slot] = null;
      victim.slots[s.pendingGive.toSlot] = card;
      log(
        s,
        `${snapper.name} hands a card to ${victim.name} (slot ${s.pendingGive.toSlot + 1}) and drops to ${cardsInHand(snapper)} cards.`,
      );
      log(s, `You gave away ${cardName(card)}.`, [action.playerId]);
      s.pendingGive = null;
      return { ok: true, state: s };
    }

    /* ---------------- server-driven ---------------- */

    case "forceAdvance": {
      if (s.phase !== "playing") return fail("Round is not in progress.");
      if (s.pending.kind === "drawn") {
        const card = s.pending.card;
        s.discard.push(card);
        learnAll(s, card.id, now);
        s.snapOpen = true;
        log(s, `Turn auto-played: ${cardLabel(card)} discarded.`);
      }
      s.pending = { kind: "none" };
      s.pendingGive = null;
      advanceTurn(s);
      return { ok: true, state: s };
    }

    default: {
      const never: never = action;
      return fail(`Unknown action: ${JSON.stringify(never)}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * roster management (used by the room server)
 * ------------------------------------------------------------------ */

export function addPlayer(state: GameState, id: string, name: string): ApplyResult {
  const s = clone(state);
  if (getPlayer(s, id)) return fail("Already joined.");
  if (s.players.length >= MAX_PLAYERS) return fail(`Room is full (max ${MAX_PLAYERS}).`);
  if (s.phase !== "lobby" && s.phase !== "roundEnd" && s.phase !== "gameEnd") {
    return fail("A round is in progress - you'll be seated for the next one.");
  }
  const isHost = s.players.length === 0;
  s.players.push({
    id,
    name,
    connected: true,
    slots: [],
    score: 0,
    lastRoundScore: null,
    isHost,
  });
  s.knowledge[id] = {};
  s.initialPeeks[id] = 0;
  if (!s.turnOrder.includes(id)) s.turnOrder.push(id);
  log(s, `${name} joined.`);
  return { ok: true, state: s };
}

export function setConnected(state: GameState, id: string, connected: boolean): GameState {
  const s = clone(state);
  const p = getPlayer(s, id);
  if (!p) return s;
  if (p.connected === connected) return s;
  p.connected = connected;
  log(s, `${p.name} ${connected ? "reconnected" : "disconnected"}.`);
  return s;
}

export function removePlayer(state: GameState, id: string): GameState {
  let s = clone(state);
  const p = getPlayer(s, id);
  if (!p) return s;
  // Mid-round we keep the seat (their cards still score); otherwise drop them.
  if (s.phase === "playing" || s.phase === "peek") {
    return setConnected(s, id, false);
  }
  s.players = s.players.filter((x) => x.id !== id);
  s.turnOrder = s.turnOrder.filter((x) => x !== id);
  delete s.knowledge[id];
  delete s.initialPeeks[id];
  if (s.turnIndex >= s.turnOrder.length) s.turnIndex = 0;
  if (p.isHost && s.players.length > 0) {
    (s.players[0] as Player).isHost = true;
  }
  log(s, `${p.name} left.`);
  return s;
}

/** True when the active seat cannot act and the server should auto-advance. */
export function turnIsStalled(s: GameState): boolean {
  if (s.phase !== "playing") return false;
  if (s.pendingGive) return false;
  const cur = currentPlayerId(s);
  if (!cur) return false;
  const p = getPlayer(s, cur);
  return !!p && !p.connected;
}
