// Math keypad. Each press calls onKey(code) where code is one of:
//   character keys (single-char atoms): '0'-'9', '+', '−', '×', '÷', '=',
//                                       '.', '(', ')', 'x', 'y', 'a', 'b',
//                                       '<', '>', '≤', '≥'
//   composite-creating keys: 'FRAC', 'POW', 'SQRT'
//   actions: 'BACKSPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'EXIT'

const LAYOUT = [
  [
    { code: '7', label: '7' },
    { code: '8', label: '8' },
    { code: '9', label: '9' },
    null,
    { code: '+', label: '+', kind: 'op' },
    { code: '−', label: '−', kind: 'op' },
    { code: '%', label: '%', kind: 'op' },
    null,
    { code: '(', label: '(', kind: 'op' },
    { code: ')', label: ')', kind: 'op' },
    null,
    { code: 'BACKSPACE', label: '⌫', kind: 'edit' }
  ],
  [
    { code: '4', label: '4' },
    { code: '5', label: '5' },
    { code: '6', label: '6' },
    null,
    { code: '×', label: '×', kind: 'op' },
    { code: '÷', label: '÷', kind: 'op' },
    null,
    { code: '.', label: '·', kind: 'op', title: 'נקודה עשרונית' },
    { code: '=', label: '=', kind: 'op' },
    null,
    { code: 'UP', label: '↑', kind: 'nav' }
  ],
  [
    { code: '1', label: '1' },
    { code: '2', label: '2' },
    { code: '3', label: '3' },
    null,
    { code: 'x', label: 'x', kind: 'var' },
    { code: 'y', label: 'y', kind: 'var' },
    { code: 'a', label: 'a', kind: 'var' },
    { code: 'b', label: 'b', kind: 'var' },
    null,
    { code: 'LEFT', label: '←', kind: 'nav' },
    { code: 'DOWN', label: '↓', kind: 'nav' },
    { code: 'RIGHT', label: '→', kind: 'nav' }
  ],
  [
    { code: '0', label: '0' },
    null,
    { code: '<', label: '<', kind: 'op' },
    { code: '>', label: '>', kind: 'op' },
    { code: '≤', label: '≤', kind: 'op' },
    { code: '≥', label: '≥', kind: 'op' },
    null,
    { code: 'FRAC', label: '½', kind: 'comp', title: 'שבר' },
    { code: 'POW', label: 'xⁿ', kind: 'comp', title: 'חזקה' },
    { code: 'SQRT', label: '√', kind: 'comp', title: 'שורש' },
    null,
    { code: 'EXIT', label: '⏎', kind: 'edit', title: 'יציאה משבר/חזקה' }
  ]
];

export function renderKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad';
  wrapper.setAttribute('dir', 'ltr');

  for (const row of LAYOUT) {
    const rowEl = document.createElement('div');
    rowEl.className = 'keypad__row';
    for (const button of row) {
      if (!button) {
        const gap = document.createElement('div');
        gap.className = 'keypad__gap';
        rowEl.appendChild(gap);
        continue;
      }
      const el = document.createElement('button');
      el.className = `keypad__key ${button.kind ? `keypad__key--${button.kind}` : ''}`;
      el.type = 'button';
      el.textContent = button.label;
      el.dataset.code = button.code;
      if (button.title) el.title = button.title;
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => onKey(button.code));
      rowEl.appendChild(el);
    }
    wrapper.appendChild(rowEl);
  }

  return wrapper;
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
