// English on-screen keyboard. Layout matches the iPadOS English keyboard so
// muscle memory carries over: three letter rows (10/9/9), a punctuation
// strip, then a bottom action row.
//
//   Row 1: q w e r t y u i o p
//   Row 2:  a s d f g h j k l
//   Row 3: ⇧ z x c v b n m ⌫
//   Row 4: ! : . / ( )            (punctuation strip)
//   Row 5: 123 | אבג | space (wide) | ↑ ← ↓ →
//
// Each letter key emits its lowercase glyph by default. The shift key on
// row 3 cycles through three states: off → shift (one capital) → caps lock
// (all caps until tapped off). The visual state of the shift key always
// shows which mode is active so the kid sees whether the next press will
// produce uppercase.
//
// Press codes emitted via onKey:
//   - Letters: 'a'..'z' or 'A'..'Z' depending on shift state
//   - Punctuation: '!', ':', '.', '/', '(', ')'
//   - Actions: 'BACKSPACE', 'SPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN',
//              'TOGGLE_KEYPAD' (→ math), 'TOGGLE_HEBREW' (→ hebrew)
//
// The TOGGLE_HEBREW code is unique to the English keypad — it lets the kid
// jump straight to the Hebrew layout without a detour through math.

import { makeKey, modeKey } from './keypad.js';

const LETTER_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm']
];

const PUNCTUATION = ['!', ':', '.', '/', '(', ')'];

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

  const lettersBlock = document.createElement('div');
  lettersBlock.className = 'keypad__letters';

  // Per-letter button refs so we can mutate the displayed glyph (upper vs
  // lower) when shift state changes without rebuilding the entire keypad.
  const letterButtons = [];

  function applyShiftToLetters() {
    const upper = shiftState !== SHIFT_OFF;
    for (const { btn, ch } of letterButtons) {
      btn.textContent = upper ? ch.toUpperCase() : ch;
    }
  }

  // Letter rows. Each letter button reads shiftState at click time so the
  // emitted character reflects the current toggle. After a one-shot shift
  // emits a single capital, drop back to off automatically (mirrors iPadOS).
  LETTER_ROWS.forEach((letters, rowIndex) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keypad__row';

    // Shift sits at the start of the bottom letter row, matching iPadOS.
    if (rowIndex === 2) {
      const shiftBtn = makeShiftKey(() => shiftState, (next) => {
        shiftState = next;
        applyShiftStyles(shiftBtn, shiftState);
        applyShiftToLetters();
      });
      rowEl.appendChild(shiftBtn);
      // Initial style so the lit/unlit state matches shiftState before any
      // taps (always SHIFT_OFF on first render, but explicit is safer for
      // future re-mounts).
      applyShiftStyles(shiftBtn, shiftState);
    }

    for (const ch of letters) {
      const btn = makeKey({
        code: ch,
        label: ch,
        kind: 'letter'
      }, () => {
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
      rowEl.appendChild(btn);
    }

    // Backspace lives at the right end of the bottom letter row, mirroring
    // the iPadOS English keyboard.
    if (rowIndex === 2) {
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

  // Punctuation row.
  const punctRow = document.createElement('div');
  punctRow.className = 'keypad__row keypad__row--punct';
  for (const ch of PUNCTUATION) {
    punctRow.appendChild(makeKey({ code: ch, label: ch, kind: 'op' }, onKey));
  }
  lettersBlock.appendChild(punctRow);

  // Bottom action row: 123 (math), אבג (Hebrew), wide Space, ↑ ← ↓ →.
  const actionRow = document.createElement('div');
  actionRow.className = 'keypad__row keypad__row--bottom';
  actionRow.appendChild(makeKey(modeKey('מקלדת מתמטית'), onKey));
  actionRow.appendChild(makeKey({
    code: 'TOGGLE_HEBREW',
    label: 'אבג',
    kind: 'mode',
    title: 'מקלדת עברית'
  }, onKey));
  actionRow.appendChild(makeKey({ code: 'SPACE', label: 'space', kind: 'space' }, onKey));
  actionRow.appendChild(makeKey({ code: 'UP', label: '↑', kind: 'nav' }, onKey));
  actionRow.appendChild(makeKey({ code: 'LEFT', label: '←', kind: 'nav' }, onKey));
  actionRow.appendChild(makeKey({ code: 'DOWN', label: '↓', kind: 'nav' }, onKey));
  actionRow.appendChild(makeKey({ code: 'RIGHT', label: '→', kind: 'nav' }, onKey));
  lettersBlock.appendChild(actionRow);

  wrapper.appendChild(lettersBlock);
  return wrapper;
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
