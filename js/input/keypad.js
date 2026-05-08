// Math keypad. Each press calls onKey(code) where code is one of:
//   character keys (single-char atoms): '0'-'9', '+', '−', '×', '÷', '=',
//                                       '.', '(', ')', 'x', 'y', 'a', 'b',
//                                       '<', '>', '≤', '≥'
//   composite-creating keys: 'FRAC', 'POW', 'SQRT'
//   actions: 'BACKSPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'EXIT'
//
// The keypad renders as a row of independent SECTIONS, each its own CSS grid.
// This is what gives the digits a clean 3x3 (with 0 centered below) and the
// arrows a true symmetric cross — flexbox alone couldn't keep the columns
// aligned across rows.

// Each section: { name, cols, keys }. keys is a flat list, row-major; null
// is a placeholder (renders as an invisible button so the grid keeps its
// column structure).
const SECTIONS = [
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
      null,
      { code: '0', label: '0' },
      null
    ]
  },
  {
    name: 'ops',
    cols: 4,
    keys: [
      { code: '+', label: '+', kind: 'op' },
      { code: '−', label: '−', kind: 'op' },
      { code: '×', label: '×', kind: 'op' },
      { code: '÷', label: '÷', kind: 'op' },
      { code: '(', label: '(', kind: 'op' },
      { code: ')', label: ')', kind: 'op' },
      { code: '.', label: '·', kind: 'op', title: 'נקודה עשרונית' },
      { code: '=', label: '=', kind: 'op' },
      { code: '<', label: '<', kind: 'op' },
      { code: '>', label: '>', kind: 'op' },
      { code: '≤', label: '≤', kind: 'op' },
      { code: '≥', label: '≥', kind: 'op' },
      { code: 'x', label: 'x', kind: 'var' },
      { code: 'y', label: 'y', kind: 'var' },
      { code: 'a', label: 'a', kind: 'var' },
      { code: 'b', label: 'b', kind: 'var' }
    ]
  },
  {
    name: 'composites',
    cols: 3,
    keys: [
      { code: 'FRAC', label: '½', kind: 'comp', title: 'שבר' },
      { code: 'POW', label: 'xⁿ', kind: 'comp', title: 'חזקה' },
      { code: 'SQRT', label: '√', kind: 'comp', title: 'שורש' },
      { code: '%', label: '%', kind: 'op' },
      { code: 'EXIT', label: '⏎', kind: 'edit', title: 'יציאה משבר/חזקה' },
      { code: 'TOGGLE_KEYPAD', label: 'אבג', kind: 'mode', title: 'מקלדת עברית' }
    ]
  },
  {
    name: 'arrows',
    cols: 3,
    keys: [
      null,
      { code: 'UP', label: '↑', kind: 'nav' },
      null,
      { code: 'LEFT', label: '←', kind: 'nav' },
      { code: 'DOWN', label: '↓', kind: 'nav' },
      { code: 'RIGHT', label: '→', kind: 'nav' },
      null,
      { code: 'BACKSPACE', label: '⌫', kind: 'edit' },
      null
    ]
  }
];

export function renderKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--sectioned';
  wrapper.setAttribute('dir', 'ltr');

  for (const section of SECTIONS) {
    wrapper.appendChild(buildSection(section, onKey));
  }

  return wrapper;
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

function makeKey(button, onKey) {
  const el = document.createElement('button');
  el.className = `keypad__key ${button.kind ? `keypad__key--${button.kind}` : ''}`;
  el.type = 'button';
  el.textContent = button.label;
  el.dataset.code = button.code;
  if (button.title) el.title = button.title;
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
