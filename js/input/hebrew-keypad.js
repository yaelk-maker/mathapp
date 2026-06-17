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
// The keypad shares the math keypad's 9-column × 5-row grid. Columns 1–7
// hold the content (a signs row on top, three letter rows, then a wide
// Space), and columns 8–9 hold the navigation/globe cluster via
// appendNavCluster — so the right strip is identical to the numeric keypad
// and the two keypads are the same height.
//
//   Row 1 (cols 1–7): signs  ! : . , / ( )        | ⌫
//   Row 2 (cols 1–7): ק ר א ט ו ן ם פ              | ↑
//   Row 3 (cols 1–7): ש ד ג כ ע י ח ל ך ף          | ← →
//   Row 4 (cols 1–7): ז ס ב ה נ מ צ ת ץ            | ↓
//   Row 5 (cols 1–7): [ רווח (wide) ]              | 🌐

import { makeKey, appendNavCluster } from './keypad.js';

const LETTER_ROWS = [
  ['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'],
  ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
  ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ']
];

const PUNCTUATION = ['!', ':', '.', ',', '/', '(', ')', "'", '-'];

export function renderHebrewKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--hebrew';
  wrapper.setAttribute('dir', 'ltr');

  const grid = document.createElement('div');
  grid.className = 'keypad__grid keypad__grid--letters';

  // Row 1: signs (punctuation) strip across columns 1–7.
  contentRow(grid, 1, (row) => {
    for (const ch of PUNCTUATION) {
      row.appendChild(makeKey({ code: ch, label: ch, kind: 'op' }, onKey));
    }
  });

  // Rows 2–4: Hebrew letters across columns 1–7.
  LETTER_ROWS.forEach((letters, i) => {
    contentRow(grid, i + 2, (row) => {
      for (const ch of letters) {
        row.appendChild(makeKey({ code: ch, label: ch, kind: 'letter' }, onKey));
      }
    });
  });

  // Row 5: wide Space across columns 1–7.
  const space = makeKey({ code: 'SPACE', label: 'רווח', kind: 'space' }, onKey);
  space.style.gridRow = '5';
  space.style.gridColumn = '1 / span 7';
  grid.appendChild(space);

  // Columns 8–9: the shared ⌫/↑/←→/↓/🌐 cluster, identical to the numeric
  // keypad's right strip.
  appendNavCluster(grid, onKey);

  wrapper.appendChild(grid);
  return wrapper;
}

// A content row that spans columns 1–7 of the grid at the given row number.
// The keys inside live in a flex row so they stretch to share the 7-column
// width regardless of how many there are (Hebrew's longest row is 10 keys).
function contentRow(grid, rowNum, fill) {
  const row = document.createElement('div');
  row.className = 'keypad__gridrow';
  row.style.gridRow = String(rowNum);
  row.style.gridColumn = '1 / span 7';
  fill(row);
  grid.appendChild(row);
  return row;
}
