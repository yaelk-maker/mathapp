// English on-screen keyboard. Layout matches the iPadOS English keyboard so
// muscle memory carries over: three letter rows (10/9/8-with-shift), a signs
// row, and a wide Space.
//
// The keypad shares the math keypad's 9-column × 5-row grid. Columns 1–7
// hold the content (a signs row on top, three letter rows, then a wide
// Space), and columns 8–9 hold the navigation/globe cluster via
// appendNavCluster — so the right strip is identical to the numeric keypad
// and the two keypads are the same height.
//
//   Row 1 (cols 1–7): signs  ! : . , / ( )        | ⌫
//   Row 2 (cols 1–7): q w e r t y u i o p          | ↑
//   Row 3 (cols 1–7): a s d f g h j k l            | ← →
//   Row 4 (cols 1–7): ⇧ z x c v b n m              | ↓
//   Row 5 (cols 1–7): [ space (wide) ]             | 🌐
//
// Each letter key emits its lowercase glyph by default. The shift key on
// the bottom letter row cycles through three states: off → shift (one
// capital) → caps lock (all caps until tapped off). The visual state of the
// shift key always shows which mode is active.
//
// Press codes emitted via onKey:
//   - Letters: 'a'..'z' or 'A'..'Z' depending on shift state
//   - Punctuation: '!', ':', '.', ',', '/', '(', ')'
//   - Actions: 'BACKSPACE', 'SPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN',
//              'TOGGLE_KEYPAD' (globe — cycles to the next keyboard)

import { makeKey, appendNavCluster } from './keypad.js';

const LETTER_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm']
];

const PUNCTUATION = ['!', ':', '.', ',', '/', '(', ')'];

// Shift state machine. Tapping the shift key advances through the cycle:
// off → shift (single uppercase, drops back after the next letter) → locked
// (stays uppercase until tapped off) → off.
const SHIFT_OFF = 'off';
const SHIFT_ONCE = 'once';
const SHIFT_LOCKED = 'locked';

export function renderEnglishKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--english';
  wrapper.setAttribute('dir', 'ltr');

  let shiftState = SHIFT_OFF;

  const grid = document.createElement('div');
  grid.className = 'keypad__grid keypad__grid--letters';

  // Per-letter button refs so we can mutate the displayed glyph (upper vs
  // lower) when shift state changes without rebuilding the entire keypad.
  const letterButtons = [];

  function applyShiftToLetters() {
    const upper = shiftState !== SHIFT_OFF;
    for (const { btn, ch } of letterButtons) {
      btn.textContent = upper ? ch.toUpperCase() : ch;
    }
  }

  // Row 1: signs (punctuation) strip across columns 1–7.
  contentRow(grid, 1, (row) => {
    for (const ch of PUNCTUATION) {
      row.appendChild(makeKey({ code: ch, label: ch, kind: 'op' }, onKey));
    }
  });

  // Rows 2–4: letter rows across columns 1–7. The bottom letter row leads
  // with the shift key (matching iPadOS). Each letter button reads shiftState
  // at click time and a one-shot shift drops back to off after one capital.
  LETTER_ROWS.forEach((letters, rowIndex) => {
    contentRow(grid, rowIndex + 2, (row) => {
      if (rowIndex === 2) {
        const shiftBtn = makeShiftKey(() => shiftState, (next) => {
          shiftState = next;
          applyShiftStyles(shiftBtn, shiftState);
          applyShiftToLetters();
        });
        row.appendChild(shiftBtn);
        applyShiftStyles(shiftBtn, shiftState);
      }

      for (const ch of letters) {
        const btn = makeKey({ code: ch, label: ch, kind: 'letter' }, () => {
          const upper = shiftState !== SHIFT_OFF;
          onKey(upper ? ch.toUpperCase() : ch);
          if (shiftState === SHIFT_ONCE) {
            shiftState = SHIFT_OFF;
            const shiftBtn = wrapper.querySelector('.keypad__key--shift');
            if (shiftBtn) applyShiftStyles(shiftBtn, shiftState);
            applyShiftToLetters();
          }
        });
        letterButtons.push({ btn, ch });
        row.appendChild(btn);
      }
    });
  });

  // Row 5: wide Space across columns 1–7.
  const space = makeKey({ code: 'SPACE', label: 'space', kind: 'space' }, onKey);
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
// width regardless of how many there are.
function contentRow(grid, rowNum, fill) {
  const row = document.createElement('div');
  row.className = 'keypad__gridrow';
  row.style.gridRow = String(rowNum);
  row.style.gridColumn = '1 / span 7';
  fill(row);
  grid.appendChild(row);
  return row;
}

// Shift key — single tap advances off → once → locked → off. The caller
// passes a reader for the current state and a setter to apply the next one.
// We build the key directly (not via makeKey) because none of the makeKey
// branches matches the cycle-state behaviour we need here.
function makeShiftKey(getState, setState) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'keypad__key keypad__key--shift';
  el.textContent = '⇧';
  el.title = 'Caps Lock';
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', () => {
    const cur = getState();
    let next;
    if (cur === SHIFT_OFF) next = SHIFT_ONCE;
    else if (cur === SHIFT_ONCE) next = SHIFT_LOCKED;
    else next = SHIFT_OFF;
    setState(next);
  });
  return el;
}

function applyShiftStyles(btn, state) {
  btn.classList.toggle('keypad__key--shift-active', state === SHIFT_ONCE);
  btn.classList.toggle('keypad__key--shift-locked', state === SHIFT_LOCKED);
  // Visual glyph carries the current intent: hollow arrow when off, filled
  // arrow when shifted once, filled + underline (drawn by CSS) when locked.
  if (state === SHIFT_LOCKED) {
    btn.textContent = '⇪';
    btn.setAttribute('aria-label', 'Caps Lock פעיל');
  } else if (state === SHIFT_ONCE) {
    btn.textContent = '⇧';
    btn.setAttribute('aria-label', 'Shift פעיל');
  } else {
    btn.textContent = '⇧';
    btn.setAttribute('aria-label', 'Shift');
  }
}
