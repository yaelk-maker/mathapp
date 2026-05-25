// Hebrew on-screen keyboard. The kid taps letters, they go into the active
// work-block grid one cell each (the editor's handleHebrewKey routes them).
// Layout matches a real Hebrew QWERTY (the keyboard the kid sees on iPad
// system keyboard) so muscle memory carries over: Q-row is ק ר א ט ו ן ם פ
// reading LEFT-TO-RIGHT, with ק at the leftmost position.
//
// IMPORTANT: the wrapper renders dir="ltr" — the keys themselves contain
// Hebrew letters which are RTL-marked Unicode, but the KEY ORDER is LTR so
// it visually matches a physical Hebrew QWERTY.
//
// Layout (top to bottom):
//   Row 1: 8 letters + ⌫
//   Row 2: 10 letters
//   Row 3: 9 letters
//   Row 4: punctuation strip (! : . / ( ))
//   Row 5: ABC/123 + רווח (wide) + ↑ ← ↓ →
// The arrows live on the bottom action row alongside mode-toggle and
// space; punctuation sits directly above them.

import { makeKey, modeKey } from './keypad.js';

const LETTER_ROWS = [
  ['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'],
  ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
  ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ']
];

const PUNCTUATION = ['!', ':', '.', '/', '(', ')'];

export function renderHebrewKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--hebrew';
  wrapper.setAttribute('dir', 'ltr');

  // Letters and the punctuation/action rows sit in a column block so the
  // bottom rows hug the same width as the letter rows above them.
  const lettersBlock = document.createElement('div');
  lettersBlock.className = 'keypad__letters';

  LETTER_ROWS.forEach((letters, rowIndex) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keypad__row';
    for (const ch of letters) {
      rowEl.appendChild(makeKey({ code: ch, label: ch, kind: 'letter' }, onKey));
    }
    // Backspace lives at the right end of the top row (matches the iPadOS
    // Hebrew keyboard).
    if (rowIndex === 0) {
      rowEl.appendChild(makeKey({
        code: 'BACKSPACE',
        label: '⌫',
        kind: 'edit',
        title: 'מחק (החזקה למחיקה רציפה)',
        repeat: true
      }, onKey));
    }
    lettersBlock.appendChild(rowEl);
  });

  // Punctuation row — sits above the bottom action row. Includes a
  // NEWLINE key so the kid can drop to the next row in Hebrew text
  // without an arrow-key shuffle. handleHebrewKey already handles
  // NEWLINE; previously no on-screen key emitted it. (Bilingual QA bug.)
  const punctRow = document.createElement('div');
  punctRow.className = 'keypad__row keypad__row--punct';
  for (const ch of PUNCTUATION) {
    punctRow.appendChild(makeKey({ code: ch, label: ch, kind: 'op' }, onKey));
  }
  punctRow.appendChild(makeKey({
    code: 'NEWLINE',
    label: '⏎',
    kind: 'edit',
    title: 'שורה חדשה'
  }, onKey));
  lettersBlock.appendChild(punctRow);

  // Bottom action row: math toggle, English toggle, wide Space, then arrows.
  // Mirrors the English keypad's bottom row so both alphabet keypads expose
  // a one-tap hop to the other alphabet AND back to math, matching iPadOS
  // where the language globe sits next to the 123 key.
  const actionRow = document.createElement('div');
  actionRow.className = 'keypad__row keypad__row--bottom';
  actionRow.appendChild(makeKey(modeKey('מקלדת מתמטית'), onKey));
  actionRow.appendChild(makeKey({
    code: 'TOGGLE_ENGLISH',
    label: 'ABC',
    kind: 'mode',
    title: 'מקלדת אנגלית'
  }, onKey));
  actionRow.appendChild(makeKey({ code: 'SPACE', label: 'רווח', kind: 'space' }, onKey));
  actionRow.appendChild(makeKey({ code: 'UP', label: '↑', kind: 'nav' }, onKey));
  actionRow.appendChild(makeKey({ code: 'LEFT', label: '←', kind: 'nav' }, onKey));
  actionRow.appendChild(makeKey({ code: 'DOWN', label: '↓', kind: 'nav' }, onKey));
  actionRow.appendChild(makeKey({ code: 'RIGHT', label: '→', kind: 'nav' }, onKey));
  lettersBlock.appendChild(actionRow);

  wrapper.appendChild(lettersBlock);
  return wrapper;
}
