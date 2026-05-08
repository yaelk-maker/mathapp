// Hebrew on-screen keyboard. The kid taps letters, they go into the active
// work-block grid one cell each (the editor's handleHebrewKey routes them).
// Layout matches a real Hebrew QWERTY (the keyboard the kid sees on iPad
// system keyboard) so muscle memory carries over: Q-row is ק ר א ט ו ן ם פ
// reading LEFT-TO-RIGHT, with ק at the leftmost position.
//
// IMPORTANT: the wrapper renders dir="ltr" — the keys themselves contain
// Hebrew letters which are RTL-marked Unicode, but the KEY ORDER is LTR so
// it visually matches a physical Hebrew QWERTY. Setting the wrapper to
// dir="rtl" would mirror the row order, which is exactly the bug we just
// fixed.
//
// Hebrew typing in the grid flows RTL (cursor advances left after each
// letter — see handleHebrewKey in editor.js). Arrow keys are exposed here
// so the kid can fix a single Hebrew letter without backspacing through.

import { buildSection, makeKey, modeKey } from './keypad.js';

const ROWS = [
  ['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'],
  ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
  ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ']
];

export function renderHebrewKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--hebrew';
  wrapper.setAttribute('dir', 'ltr');

  // Letters are still flexed into rows — Hebrew QWERTY has variable widths
  // per row, so flex matches a physical keyboard better than a grid.
  const lettersBlock = document.createElement('div');
  lettersBlock.className = 'keypad__letters';
  ROWS.forEach((letters, rowIndex) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keypad__row';
    for (const ch of letters) {
      rowEl.appendChild(makeKey({ code: ch, label: ch, kind: 'letter' }, onKey));
    }
    // Backspace lives at the right end of the top row (matches the iPadOS
    // Hebrew keyboard); the dedicated arrow-cluster below has no backspace.
    if (rowIndex === 0) {
      rowEl.appendChild(makeKey({
        code: 'BACKSPACE',
        label: '⌫',
        kind: 'edit',
        title: 'מחק'
      }, onKey));
    }
    lettersBlock.appendChild(rowEl);
  });

  // Bottom action row (LTR): mode-switch + wide space. Punctuation and
  // newline keys were dropped — kids type free-text answers as one line.
  const actionRow = document.createElement('div');
  actionRow.className = 'keypad__row keypad__row--bottom';
  actionRow.appendChild(makeKey(modeKey('מקלדת מתמטית'), onKey));
  const space = makeKey({ code: 'SPACE', label: 'רווח', kind: 'space' }, onKey);
  actionRow.appendChild(space);
  lettersBlock.appendChild(actionRow);
  wrapper.appendChild(lettersBlock);

  // Arrow cluster: ↑ on top row alone (centered), ←↓→ below. Matches the
  // image in the spec — without backspace, since that moved to the letter
  // row's right end.
  wrapper.appendChild(
    buildSection(
      {
        name: 'arrows',
        cols: 3,
        keys: [
          null,
          { code: 'UP', label: '↑', kind: 'nav' },
          null,
          { code: 'LEFT', label: '←', kind: 'nav' },
          { code: 'DOWN', label: '↓', kind: 'nav' },
          { code: 'RIGHT', label: '→', kind: 'nav' }
        ]
      },
      onKey
    )
  );

  return wrapper;
}
