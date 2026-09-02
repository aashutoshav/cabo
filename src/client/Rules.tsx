export function Rules({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card rules" onClick={(e) => e.stopPropagation()}>
        <header className="rules-head">
          <h2>House rules</h2>
          <button className="btn btn-ghost" onClick={onClose}>close</button>
        </header>

        <p className="rules-lede">
          Standard 52-card deck, four cards each. Lowest hand wins the round. First player to cross
          100 loses, and the lowest total score wins the game.
        </p>

        <h3>Card values</h3>
        <table className="rules-table">
          <tbody>
            <tr><td>A</td><td>1</td><td>-</td></tr>
            <tr><td>2 - 6</td><td>face value</td><td>-</td></tr>
            <tr><td>7, 8</td><td>7, 8</td><td>Peek at one of your own cards</td></tr>
            <tr><td>9, 10</td><td>9, 10</td><td>Spy one opponent card</td></tr>
            <tr><td>J</td><td>11</td><td>Blind swap - one of yours for one of theirs, unseen</td></tr>
            <tr><td>Q</td><td>12</td><td>Look at any 1 card, then swap any 2 cards on the board</td></tr>
            <tr><td>K&#9824; K&#9827;</td><td>13</td><td>Look at any 2 cards, then swap any 2 cards</td></tr>
            <tr className="rules-prize">
              <td>K&#9829; K&#9830;</td><td>-1</td><td>No power - it is the prize card</td>
            </tr>
          </tbody>
        </table>
        <p className="rules-note">
          Q and K are independent: the look and the swap need not involve the same cards, and the
          swap can be between two other players entirely. The swap is optional. Powers fire only
          when you draw from the deck and discard without keeping - never off a taken discard.
        </p>

        <h3>Your turn</h3>
        <ol>
          <li>Draw from the deck, then either swap it into a slot or discard it and optionally use its power.</li>
          <li>Or take the top discard - which you <em>must</em> swap in, and which grants no power.</li>
          <li>Or call Cabo.</li>
        </ol>

        <h3>Snapping</h3>
        <p>
          Any player, at any time, may snap a card matching the top discard&apos;s <strong>rank</strong>.
          Kings match kings regardless of colour. The window opens the moment a card lands face up
          and shuts when the next player starts their turn. Fastest message wins, and chains are
          legal - a successful snap leaves the same rank on top.
        </p>
        <ul>
          <li><strong>Self-snap hit:</strong> the card is gone for good and the slot stays empty forever.</li>
          <li><strong>Self-snap miss:</strong> the card flips back and you take 1 penalty card. Everyone saw it.</li>
          <li><strong>Opponent snap hit:</strong> their card goes to the discard, then you choose one of your own cards to hand into that slot, face down. This is how you dump a king on somebody.</li>
          <li><strong>Opponent snap miss:</strong> their card flips back untouched and you take 1 penalty card.</li>
          <li>You can never snap away your last card, and you need a spare card before snapping an opponent.</li>
          <li>Snapping pauses while a power resolves.</li>
        </ul>

        <h3>Calling Cabo</h3>
        <p>
          Your hand locks and everyone else gets exactly one final turn. The caller is
          <strong> always safe</strong>: no swaps against them in either direction, and no snaps
          against their cards. Looking and spying at their cards is still allowed. The caller may
          still snap - shedding their own cards and dumping on others.
        </p>

        <h3>Scoring</h3>
        <ul>
          <li>Caller lowest (ties go to the caller): they score <strong>0</strong> - or their actual total if it is negative, so a winning -1 stays -1.</li>
          <li>Caller beaten: their total <strong>+ 5</strong>.</li>
          <li>Everyone else: their hand total, always.</li>
          <li>Land on exactly 100 and your score drops to 50. Cross 100 and the game ends.</li>
        </ul>
      </div>
    </div>
  );
}
