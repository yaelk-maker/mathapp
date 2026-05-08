// Math keypad. Each press calls onKey(code) where code is one of:
//   character keys: '0'-'9', '+', '−', '×', '÷', '=', '.', '(', ')'
//   actions: 'BACKSPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN'

const LAYOUT = [
  // Each row is an array of buttons; null = a small visual gap.
  [
    { code: '7', label: '7' },
    { code: '8', label: '8' },
    { code: '9', label: '9' },
    null,
    { code: '+', label: '+', kind: 'op' },
    { code: '−', label: '−', kind: 'op' },
    null,
    { code: '(', label: '(', kind: 'op' },
    { code: ')', label: ')', kind: 'op' },
    null,
    { code: 'BACKSPACE', label: '⌫', kind: 'edit', wide: true }
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
    null,
    null,
    null,
    null,
    null,
    null,
    { code: 'LEFT', label: '←', kind: 'nav' },
    { code: 'DOWN', label: '↓', kind: 'nav' },
    { code: 'RIGHT', label: '→', kind: 'nav' }
  ],
  [
    { code: '0', label: '0', wide: true }
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
      el.className = `keypad__key ${button.kind ? `keypad__key--${button.kind}` : ''} ${
        button.wide ? 'keypad__key--wide' : ''
      }`;
      el.type = 'button';
      el.textContent = button.label;
      el.dataset.code = button.code;
      if (button.title) el.title = button.title;
      // Prevent the button from stealing focus / scrolling on iPadOS.
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => onKey(button.code));
      rowEl.appendChild(el);
    }
    wrapper.appendChild(rowEl);
  }

  return wrapper;
}

// Map a hardware-keyboard event into a keypad code (or null to ignore).
export function keyboardEventToCode(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const k = event.key;
  if (k >= '0' && k <= '9') return k;
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
    case 'Backspace': return 'BACKSPACE';
    case 'Delete': return 'BACKSPACE';
    case 'ArrowLeft': return 'LEFT';
    case 'ArrowRight': return 'RIGHT';
    case 'ArrowUp': return 'UP';
    case 'ArrowDown': return 'DOWN';
    default: return null;
  }
}
