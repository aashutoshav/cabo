import type { Card } from "../engine/cards";
import { SUIT_SYMBOL, cardValue, isRed, powerOf } from "../engine/cards";
import type { SlotView } from "../engine/view";

const RANK_LABEL: Record<number, string> = {
  1: "A", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
  8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K",
};

export function CardFace({ card, small }: { card: Card; small?: boolean }) {
  const value = cardValue(card);
  // A red king is the -1 prize card, so it gets its own treatment.
  const prize = value === -1;
  const cls = [
    "card",
    small ? "card-sm" : "",
    isRed(card.suit) ? "card-red" : "card-black",
    prize ? "card-prize" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      <span className="card-corner">
        {RANK_LABEL[card.rank]}
        <span className="card-suit">{SUIT_SYMBOL[card.suit]}</span>
      </span>
      <span className="card-pip">{SUIT_SYMBOL[card.suit]}</span>
      <span className="card-value">{value > 0 ? value : value}</span>
    </div>
  );
}

export interface SlotProps {
  slot: SlotView;
  index: number;
  /** Highlighted as a legal tap target. */
  selectable?: boolean;
  selected?: boolean;
  /** Dimmed and inert, e.g. the locked Cabo caller's hand. */
  locked?: boolean;
  onClick?: () => void;
  small?: boolean;
  /** Fraction of the reveal window left (1 -> 0), or null if it never hides. */
  countdown?: number | null;
}

export function Slot({ slot, index, selectable, selected, locked, onClick, small, countdown }: SlotProps) {
  if (slot.state === "empty") {
    return (
      <div className={`slot slot-empty ${small ? "slot-sm" : ""}`} title="Shed - gone for good">
        <span className="slot-index">{index + 1}</span>
      </div>
    );
  }

  const cls = [
    "slot",
    small ? "slot-sm" : "",
    selectable ? "slot-selectable" : "",
    selected ? "slot-selected" : "",
    locked ? "slot-locked" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={cls}
      onClick={selectable ? onClick : undefined}
      disabled={!selectable}
      aria-label={
        slot.state === "known"
          ? `Slot ${index + 1}: ${RANK_LABEL[slot.card.rank]} of ${slot.card.suit}`
          : `Slot ${index + 1}: face down`
      }
    >
      {slot.state === "known" ? (
        <>
          <CardFace card={slot.card} small={small} />
          {countdown !== null && countdown !== undefined && (
            <span className="slot-timer" style={{ width: `${Math.max(0, countdown) * 100}%` }} />
          )}
        </>
      ) : (
        <div className={`card card-back ${small ? "card-sm" : ""}`}>
          <span className="card-back-mark">?</span>
        </div>
      )}
      <span className="slot-index">{index + 1}</span>
    </button>
  );
}

export function PowerBadge({ card }: { card: Card }) {
  const power = powerOf(card);
  if (!power) return null;
  const label: Record<string, string> = {
    peekOwn: "Peek own",
    spyOther: "Spy",
    blindSwap: "Blind swap",
    look1swap2: "Look 1, swap 2",
    look2swap2: "Look 2, swap 2",
  };
  return <span className="power-badge">{label[power]}</span>;
}
