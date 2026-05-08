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

const ROWS = [
  ['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'],
  ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
  ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ']
];

export function renderHebrewKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--hebrew';
  wrapper.setAttribute('dir', 'ltr');

  for (const letters of ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'keypad__row';
    for (const ch of letters) {
      rowEl.appendChild(makeKey(ch, ch, 'letter', onKey));
    }
    wrapper.appendChild(rowEl);
  }

  // Bottom action row (LTR): mode-switch, punctuation, space, newline,
  // backspace. Punctuation is small to keep the row compact.
  const actionRow = document.createElement('div');
  actionRow.className = 'keypad__row';
  actionRow.appendChild(makeKey('TOGGLE_KEYPAD', '123', 'mode', onKey));
  actionRow.appendChild(makeKey('.', '.', 'op', onKey));
  actionRow.appendChild(makeKey(',', ',', 'op', onKey));
  actionRow.appendChild(makeKey('?', '?', 'op', onKey));
  actionRow.appendChild(makeKey('!', '!', 'op', onKey));
  const space = makeKey('SPACE', 'רווח', 'wide', onKey);
  space.classList.add('keypad__key--wide');
  actionRow.appendChild(space);
  actionRow.appendChild(makeKey('NEWLINE', '↵', 'nav', onKey));
  actionRow.appendChild(makeKey('BACKSPACE', '⌫', 'edit', onKey));
  wrapper.appendChild(actionRow);

  return wrapper;
}

function makeKey(code, label, kind, onKey) {
  const el = document.createElement('button');
  el.className = `keypad__key ${kind ? `keypad__key--${kind}` : ''}`;
  el.type = 'button';
  el.textContent = label;
  el.dataset.code = code;
  // mousedown/pointerdown preventDefault so a tap doesn't blur whatever
  // owns input focus (in our case nothing — we drive the grid directly —
  // but keep it for safety and to suppress the iOS click delay).
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('click', () => onKey(code));
  return el;
}
