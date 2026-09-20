# Cabo

Online multiplayer Cabo. Create a room, share the key, play from anywhere.

Built as a single Cloudflare Worker that serves both the React client and the
authoritative game server — one deploy, one origin, no CORS, and free to run.

## Why this architecture

Cabo is a hidden-information game: every player's four cards and the deck order
must stay secret, and snapping is a sub-second race that needs one arbiter
deciding who was genuinely first. That rules out keeping game state in the
browser or in any database the clients can read.

A **Durable Object** solves both problems at once:

- One object per room key (`idFromName("PLUM4213")`), so the key *is* the identity.
- It holds the deck in memory and never serializes it to clients. Each player
  receives a redacted view containing only cards they have earned the right to
  see (see `src/engine/view.ts`).
- It is single-threaded, so snap races need no locks or transactions — whichever
  message arrives first is processed first.
- WebSocket Hibernation keeps idle rooms alive at zero compute cost.

### Free-tier headroom

| Metric | Free allowance | A long session uses |
| --- | --- | --- |
| DO requests | 100,000/day | a few thousand |
| Incoming WS messages | billed 20:1, so ~2,000,000/day | a few thousand |
| Compute duration | 13,000 GB-s/day | negligible with hibernation |
| Storage | 5 GB | kilobytes per room |

## Layout

```
src/
  engine/     pure TypeScript rules - no runtime dependencies, fully unit tested
    cards.ts    deck, values, power mapping
    types.ts    state and action types
    engine.ts   the reducer: every rule lives here
    view.ts     per-player redaction (the thing that keeps cards secret)
  worker/
    index.ts    routes /api/* and serves the SPA
    room.ts     the Durable Object: one per room key
    protocol.ts client/server messages and room-key helpers
  client/     React UI
```

The engine is deliberately free of Workers and DOM APIs, so the rules can be
tested in plain Node in milliseconds.

## Develop

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. To play several players locally, add `?seat=2`,
`?seat=3` and so on to the URL — each seat gets its own identity in the same
browser.

```bash
npm test          # 58 rule tests
npm run typecheck # client and worker are typechecked separately
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

That publishes to `https://cabo.<your-subdomain>.workers.dev`. Add a custom
domain from the Cloudflare dashboard under Workers → your worker → Settings →
Domains & Routes if you want a nicer URL.

## House rules

Standard 52-card deck, four cards each, lowest hand wins the round.

| Card | Value | Power on discard |
| --- | --- | --- |
| A | 1 | — |
| 2–6 | face | — |
| 7, 8 | 7, 8 | Peek at one of your own cards |
| 9, 10 | 9, 10 | Spy one opponent card |
| J | 11 | Blind swap — any two cards on the board, unseen |
| Q | 12 | Look at any 1 card, then swap any 2 cards on the board |
| K♠ K♣ | 13 | Look at any 2 cards, then swap any 2 cards |
| K♥ K♦ | **−1** | none — the prize card |

Q and K are independent: the look and the swap need not involve the same cards,
the swap may be between two other players entirely, and it is optional. Powers
fire only when you draw from the deck and discard without keeping — never off a
card taken from the discard pile, which must be swapped in.

**Memory mode — on by default, and this is real Cabo.** Any card you see (the
two opening peeks, a spy, a queen's look, a snap flip) stays visible for three
seconds and then turns back over; after that, remembering it is your problem.
The opening peeks hold until the whole table is ready, so everyone's three
seconds start together.

Expiry is enforced on the server: once a sighting lapses the card stops being
sent to that player at all, so it cannot be recovered from devtools. The client
runs the countdown locally as well, purely so the flip-back is crisp.

The host can turn it off between rounds, which gives **assist mode** — the
version where you don't have to remember your cards, and everything you have
seen stays face up. The UI says so plainly while it is active.

**Snapping.** Any player, any time, may snap a card matching the top discard's
rank. Kings match kings regardless of colour. The window opens when a card
lands face up and shuts when the next player starts their turn; chains are
legal, and snapping pauses while a power resolves.

- Self-snap hit: the card is gone and the slot stays empty forever.
- Self-snap miss: it flips back (everyone saw it) and you take 1 penalty card.
- Opponent snap hit: their card is discarded, then you choose one of your own
  cards to hand face down into that slot.
- Opponent snap miss: their card is untouched and you take 1 penalty card.
- You can never snap away your last card, and you need a spare card before
  snapping an opponent.

**Cabo.** Your hand locks and everyone else takes exactly one final turn. The
caller is **always safe**: no swaps in either direction and no snaps against
their cards. Looking and spying at them is still allowed, and the caller may
still snap others.

**Scoring.** Caller lowest (ties to the caller) scores 0 — or their actual total
if negative, so a winning −1 stays −1. Caller beaten scores their total + 5.
Everyone else scores their hand. Land on exactly 100 and you drop to 50; cross
100 and the game ends with the lowest total winning.
