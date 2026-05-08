// Hebrew on-screen keyboard. Inserts characters into whichever textarea is
// currently focused (the editor tracks that target). Layout matches the
// standard Israeli QWERTY-Hebrew arrangement that the kid sees on her iPad's
// system keyboard so muscle memory carries over.

const ROWS = [
  ['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'],
  ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
  ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ']
];

const PUNCTUATION = ['.', ',', '?', '!', ':', '-', '"', "'"];

export function renderHebrewKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--hebrew';
  wrapper.setAttribute('dir', 'rtl');

  for (const letters of ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'keypad__row';
    for (const ch of letters) {
      rowEl.appendChild(makeKey(ch, ch, 'letter', onKey));
    }
    wrapper.appendChild(rowEl);
  }

  // Punctuation row
  const punctRow = document.createElement('div');
  punctRow.className = 'keypad__row';
  for (const ch of PUNCTUATION) {
    punctRow.appendChild(makeKey(ch, ch, 'op', onKey));
  }
  wrapper.appendChild(punctRow);

  // Action row: space (wide), newline, backspace
  const actionRow = document.createElement('div');
  actionRow.className = 'keypad__row';
  actionRow.appendChild(makeKey('BACKSPACE', '⌫', 'edit', onKey));
  actionRow.appendChild(makeKey('NEWLINE', '↵', 'nav', onKey));
  const spaceKey = makeKey('SPACE', 'רווח', 'wide', onKey);
  spaceKey.classList.add('keypad__key--wide');
  actionRow.appendChild(spaceKey);
  wrapper.appendChild(actionRow);

  return wrapper;
}

function makeKey(code, label, kind, onKey) {
  const el = document.createElement('button');
  el.className = `keypad__key ${kind ? `keypad__key--${kind}` : ''}`;
  el.type = 'button';
  el.textContent = label;
  el.dataset.code = code;
  // Don't let the keypad steal focus from the textarea — otherwise every key
  // press would blur the target and we'd lose track of where to insert.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('click', () => onKey(code));
  return el;
}
