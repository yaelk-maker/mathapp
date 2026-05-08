// Math keypad. Each press calls onKey(code) where code is one of:
//   character keys (single-char atoms): '0'-'9', '+', '−', '×', '÷', '=',
//                                       '.', '(', ')', 'x', 'y', 'a', 'b',
//                                       '<', '>'
//   composite-creating keys: 'FRAC', 'POW', 'SQRT', 'SQUARE', 'NROOT'
//   actions: 'BACKSPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'EXIT', 'SPACE',
//            'TOGGLE_KEYPAD'
//
// The visible keypad is split into two regions: a top row of grid SECTIONS
// (variables/algebra, digits, vertical ops column, arrows+specials) and a
// bottom action bar (mode-switch, space, backspace) that spans the full
// keypad width. EXIT is kept as an action code so the physical keyboard's
// Enter/Escape still escapes a fraction/exponent — there's just no on-screen
// button for it any more.

// Each section: { name, cols, keys }. keys is a flat list, row-major; null
// is a placeholder (renders as an invisible button so the grid keeps its
// column structure). A button can set `span` to occupy multiple grid columns
// (used for the wide ↑/↓ keys that sit above and below ←→).
const SECTIONS = [
  {
    name: 'vars',
    cols: 3,
    keys: [
      { code: 'SQUARE', label: 'a²', kind: 'comp', title: 'בריבוע' },
      { code: 'POW', label: 'aᵇ', kind: 'comp', title: 'חזקה' },
      { code: 'a', label: 'a', kind: 'var' },
      { code: 'SQRT', label: '√', kind: 'comp', title: 'שורש' },
      { code: 'NROOT', label: 'ⁿ√', kind: 'comp', title: 'שורש n-י' },
      { code: 'b', label: 'b', kind: 'var' },
      { code: '<', label: '<', kind: 'op' },
      { code: '>', label: '>', kind: 'op' },
      { code: 'x', label: 'x', kind: 'var' },
      { code: '(', label: '(', kind: 'op' },
      { code: ')', label: ')', kind: 'op' },
      { code: 'y', label: 'y', kind: 'var' }
    ]
  },
  {
    name: 'digits',
    cols: 3,
    keys: [
      { code: '7', label: '7' },
      { code: '8', label: '8' },
      { code: '9', label: '9' },
      { code: '4', label: '4' },
      { code: '5', label: '5' },
      { code: '6', label: '6' },
      { code: '1', label: '1' },
      { code: '2', label: '2' },
      { code: '3', label: '3' },
      { code: '0', label: '0' },
      { code: '.', label: '.', title: 'נקודה עשרונית' },
      { code: '=', label: '=', kind: 'op' }
    ]
  },
  {
    name: 'ops',
    cols: 1,
    keys: [
      { code: '÷', label: '÷', kind: 'op' },
      { code: '×', label: '×', kind: 'op' },
      { code: '−', label: '−', kind: 'op' },
      { code: '+', label: '+', kind: 'op' }
    ]
  },
  {
    name: 'arrows',
    cols: 2,
    keys: [
      { code: '%', label: '%', kind: 'op' },
      // Render the fraction key as a true stacked a/b — a tiny bar between
      // numerator and denominator — so it visually matches what the key
      // produces in the grid (rather than the literal text "a/b").
      {
        code: 'FRAC',
        kind: 'comp',
        title: 'שבר',
        html: '<span class="keypad__frac">'
            + '<span class="keypad__frac-num">a</span>'
            + '<span class="keypad__frac-bar"></span>'
            + '<span class="keypad__frac-den">b</span>'
            + '</span>'
      },
      { code: 'UP', label: '↑', kind: 'nav', span: 2 },
      { code: 'LEFT', label: '←', kind: 'nav' },
      { code: 'RIGHT', label: '→', kind: 'nav' },
      { code: 'DOWN', label: '↓', kind: 'nav', span: 2 }
    ]
  }
];

export function renderKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--math';
  wrapper.setAttribute('dir', 'ltr');

  const sectionsRow = document.createElement('div');
  sectionsRow.className = 'keypad__sections';
  for (const section of SECTIONS) {
    sectionsRow.appendChild(buildSection(section, onKey));
  }
  wrapper.appendChild(sectionsRow);

  // Bottom action bar: mode-toggle on the left, very wide Space in the
  // middle, backspace on the right — same shape on both math and Hebrew
  // keypads so the muscle memory carries between modes.
  const bottom = document.createElement('div');
  bottom.className = 'keypad__bottom';
  bottom.appendChild(makeKey(modeKey('מקלדת עברית'), onKey));
  bottom.appendChild(makeKey({
    code: 'SPACE',
    label: 'Space',
    kind: 'space'
  }, onKey));
  bottom.appendChild(makeKey({
    code: 'BACKSPACE',
    label: '⌫',
    kind: 'edit',
    title: 'מחק'
  }, onKey));
  wrapper.appendChild(bottom);

  return wrapper;
}

// Stacked "ABC / 123" mode-switch button — matches the iPadOS look so the
// kid recognises it as a keyboard-mode toggle rather than a character key.
export function modeKey(title) {
  return {
    code: 'TOGGLE_KEYPAD',
    kind: 'mode',
    title,
    html: '<span class="keypad__mode-top">ABC</span>'
        + '<span class="keypad__mode-bot">123</span>'
  };
}

export function buildSection(section, onKey) {
  const el = document.createElement('div');
  el.className = `keypad__section keypad__section--${section.name}`;
  el.style.gridTemplateColumns = `repeat(${section.cols}, 1fr)`;
  for (const button of section.keys) {
    if (!button) {
      const placeholder = document.createElement('div');
      placeholder.className = 'keypad__placeholder';
      el.appendChild(placeholder);
      continue;
    }
    el.appendChild(makeKey(button, onKey));
  }
  return el;
}

export function makeKey(button, onKey) {
  const el = document.createElement('button');
  el.className = `keypad__key ${button.kind ? `keypad__key--${button.kind}` : ''}`;
  el.type = 'button';
  if (button.html) el.innerHTML = button.html;
  else el.textContent = button.label;
  el.dataset.code = button.code;
  if (button.title) el.title = button.title;
  if (button.span) el.style.gridColumn = `span ${button.span}`;
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', () => onKey(button.code));
  return el;
}

export function keyboardEventToCode(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const k = event.key;
  if (k >= '0' && k <= '9') return k;
  // Variables (lowercase only)
  if (k === 'x' || k === 'y' || k === 'a' || k === 'b') return k;
  switch (k) {
    case '+': return '+';
    case '-':
    case '−': return '−';
    case '*':
    case '×': return '×';
    case '/':
    case '÷': return '÷';
    case '=': return '=';
    case '.':
    case ',': return '.';
    case '(': return '(';
    case ')': return ')';
    case '%': return '%';
    case '<': return '<';
    case '>': return '>';
    case ' ': return 'SPACE';
    case 'Backspace':
    case 'Delete': return 'BACKSPACE';
    case 'ArrowLeft': return 'LEFT';
    case 'ArrowRight': return 'RIGHT';
    case 'ArrowUp': return 'UP';
    case 'ArrowDown': return 'DOWN';
    case 'Escape':
    case 'Enter':  return 'EXIT';
    default: return null;
  }
}
