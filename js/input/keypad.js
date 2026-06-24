// Math keypad. Each press calls onKey(code) where code is one of:
//   character keys (single-char atoms): '0'-'9', '+', '−', '×', '÷', '=',
//                                       '.', '(', ')', 'x', 'y', 'a', 'b',
//                                       '<', '>', '≤', '≥', '/'
//   composite-creating keys: 'FRAC', 'POW', 'SQUARE', 'NROOT'
//   ('/' replaced the standalone √ key by request; square roots are now
//    written with ⁿ√ — type the index 2 then the radicand. The SQRT
//    composite still exists in the model so legacy notebooks render.)
//   actions: 'BACKSPACE', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'EXIT', 'SPACE',
//            'TOGGLE_KEYPAD'
//
// The whole keypad is a single 9-column × 5-row CSS grid spanning the full
// editor width — no separate sections — so wide keys like Space (span 4),
// ⌫/↑/↓/ABC/123 (span 2) sit cleanly across what used to be section
// boundaries. KEYS is row-major; `span` widens a key over multiple grid
// columns. EXIT is kept as a code so the physical Enter/Escape still
// escapes a fraction/exponent. `<` long-press → `≤`, `>` long-press →
// `≥`; the standalone keys are gone with a small superscript hint left
// behind on `<` and `>`.

// iPadOS-style globe glyph for the keyboard-switch key. Declared before KEYS
// because KEYS calls modeKey() at module-eval time, and modeKey reads this —
// a `const` after KEYS would be in its temporal dead zone and throw on load.
const GLOBE_SVG =
    '<svg class="keypad__globe" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<circle cx="12" cy="12" r="9"/>'
  + '<ellipse cx="12" cy="12" rx="4" ry="9"/>'
  + '<line x1="3" y1="12" x2="21" y2="12"/>'
  + '<line x1="4.6" y1="6.8" x2="19.4" y2="6.8"/>'
  + '<line x1="4.6" y1="17.2" x2="19.4" y2="17.2"/>'
  + '</svg>';

const KEYS = [
  // ── Row 1 ────────────────────────────────────────────────────────────
  { code: 'SQUARE', label: 'a²', kind: 'comp', title: 'בריבוע' },
  { code: 'POW', label: 'aᵇ', kind: 'comp', title: 'חזקה' },
  { code: 'a', label: 'a', kind: 'var' },
  { code: '7', label: '7' },
  { code: '8', label: '8' },
  { code: '9', label: '9' },
  { code: '÷', label: '÷', kind: 'op' },
  { code: 'BACKSPACE', label: '⌫', kind: 'edit', span: 2,
    title: 'מחק (החזקה למחיקה רציפה)', repeat: true },
  // ── Row 2 ────────────────────────────────────────────────────────────
  // Slash. Replaced the standalone √ key by request: the kid wanted a "/"
  // without changing the layout, so it sits where √ was. Square roots are
  // now written with the ⁿ√ key (index 2 + radicand) one column over.
  { code: '/', label: '/', kind: 'op', title: 'לוכסן' },
  { code: 'NROOT', label: 'ⁿ√', kind: 'comp', title: 'שורש (לשורש ריבועי: 2 ואז המספר)' },
  { code: 'b', label: 'b', kind: 'var' },
  { code: '4', label: '4' },
  { code: '5', label: '5' },
  { code: '6', label: '6' },
  { code: '×', label: '×', kind: 'op' },
  { code: 'UP', label: '↑', kind: 'nav', span: 2 },
  // ── Row 3 ────────────────────────────────────────────────────────────
  // Long-press < to type ≤; long-press > to type ≥. The tiny ≤/≥ glyph
  // in the corner of the key is the discoverability hint.
  { code: '<', kind: 'op',
    html: '<span class="keypad__longpress">≤</span><span class="keypad__main">&lt;</span>',
    longPressCode: '≤', title: 'קטן (החזקה: ≤)' },
  { code: '>', kind: 'op',
    html: '<span class="keypad__longpress">≥</span><span class="keypad__main">&gt;</span>',
    longPressCode: '≥', title: 'גדול (החזקה: ≥)' },
  { code: 'x', label: 'x', kind: 'var' },
  { code: '1', label: '1' },
  { code: '2', label: '2' },
  { code: '3', label: '3' },
  { code: '−', label: '−', kind: 'op' },
  { code: 'LEFT', label: '←', kind: 'nav' },
  { code: 'RIGHT', label: '→', kind: 'nav' },
  // ── Row 4 ────────────────────────────────────────────────────────────
  { code: '(', label: '(', kind: 'op' },
  { code: ')', label: ')', kind: 'op' },
  { code: 'y', label: 'y', kind: 'var' },
  { code: '0', label: '0' },
  { code: '.', label: '.', title: 'נקודה עשרונית' },
  { code: '=', label: '=', kind: 'op' },
  { code: '+', label: '+', kind: 'op' },
  { code: 'DOWN', label: '↓', kind: 'nav', span: 2 },
  // ── Row 5 ────────────────────────────────────────────────────────────
  // a/b fraction key rendered as a stacked numerator/bar/denominator so
  // the glyph matches what the key inserts in the grid.
  { code: 'FRAC', kind: 'comp', title: 'שבר',
    html: '<span class="keypad__frac">'
        + '<span class="keypad__frac-num">a</span>'
        + '<span class="keypad__frac-bar"></span>'
        + '<span class="keypad__frac-den">b</span>'
        + '</span>' },
  { code: '%', label: '%', kind: 'op' },
  { code: 'ABS', label: '|a|', kind: 'comp', title: 'ערך מוחלט' },
  { code: 'SPACE', label: 'Space', kind: 'space', span: 4 },
  // Mode toggle inherits modeKey's globe glyph; span 2 so it matches ⌫'s
  // footprint directly above it. One globe cycles math → hebrew → english.
  Object.assign({}, modeKey('החלפת מקלדת'), { span: 2 })
];

export function renderKeypad({ onKey }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'keypad keypad--math';
  wrapper.setAttribute('dir', 'ltr');

  const grid = document.createElement('div');
  grid.className = 'keypad__grid';
  for (const button of KEYS) {
    grid.appendChild(makeKey(button, onKey));
  }
  wrapper.appendChild(grid);
  return wrapper;
}

// Globe mode-switch button — matches the iPadOS language/keyboard globe so
// the kid recognises it as a keyboard-mode toggle rather than a character
// key. Inline SVG draws on currentColor so the per-mode tints (Hebrew /
// English) still recolour it.
export function modeKey(title) {
  return {
    code: 'TOGGLE_KEYPAD',
    kind: 'mode',
    title,
    html: GLOBE_SVG
  };
}

// Right-side navigation + keyboard-switch cluster occupying columns 8–9 of a
// 9-column keypad grid, across all 5 rows:
//   row 1: ⌫   row 2: ↑   row 3: ← →   row 4: ↓   row 5: 🌐
// These are the exact same key definitions the math keypad lays out in its
// last two columns, so the Hebrew/English keypads — which call this — get a
// right strip that is pixel-for-pixel identical to the numeric one. Keys are
// placed explicitly (the letter keypads fill columns 1–7 with their own rows,
// so we can't rely on row-major auto-flow the way the math KEYS array does).
export function appendNavCluster(grid, onKey) {
  const place = (button, row, colStart, span) => {
    const key = makeKey(button, onKey);
    key.style.gridRow = String(row);
    key.style.gridColumn = span > 1 ? `${colStart} / span ${span}` : String(colStart);
    grid.appendChild(key);
  };
  place({ code: 'BACKSPACE', label: '⌫', kind: 'edit',
          title: 'מחק (החזקה למחיקה רציפה)', repeat: true }, 1, 8, 2);
  place({ code: 'UP', label: '↑', kind: 'nav' }, 2, 8, 2);
  place({ code: 'LEFT', label: '←', kind: 'nav' }, 3, 8, 1);
  place({ code: 'RIGHT', label: '→', kind: 'nav' }, 3, 9, 1);
  place({ code: 'DOWN', label: '↓', kind: 'nav' }, 4, 8, 2);
  place(modeKey('החלפת מקלדת'), 5, 8, 2);
}

export function buildSection(section, onKey) {
  // Legacy helper kept exported only because external code may still import
  // it. The math, Hebrew and English keypads now all lay out on the single
  // 9×5 grid (math via KEYS, the letter keypads via their own rows plus
  // appendNavCluster). Safe to remove once nothing else imports buildSection.
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

// Press-and-hold tuning for `repeat: true` keys (currently just BACKSPACE).
// REPEAT_DELAY_MS = "feels like a deliberate hold, not an accidental tap";
// REPEAT_INTERVAL_MS = "fast enough to clear a six-digit cell in <1s but
// slow enough that the kid can release before deleting too far".
const REPEAT_DELAY_MS = 380;
const REPEAT_INTERVAL_MS = 80;

// Long-press alternate-key timing — used for </> → ≤/≥. Slightly longer
// than REPEAT_DELAY_MS so a kid hovering on the < key while she thinks
// doesn't accidentally trigger ≤.
const LONGPRESS_MS = 450;

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

  if (button.longPressCode) {
    // Tap → button.code; hold → button.longPressCode. Mutually exclusive
    // with `repeat: true` (only one of </> or ⌫ uses each path).
    let holdTimer = null;
    let firedLong = false;
    let suppressClick = false;
    const stop = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    };
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      firedLong = false;
      suppressClick = false;
      holdTimer = setTimeout(() => {
        firedLong = true;
        suppressClick = true;
        onKey(button.longPressCode);
        el.classList.add('keypad__key--longpress-fired');
        setTimeout(() => el.classList.remove('keypad__key--longpress-fired'), 140);
      }, LONGPRESS_MS);
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', () => { stop(); firedLong = true; });
    el.addEventListener('click', (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
        return;
      }
      if (!firedLong) onKey(button.code);
    });
    return el;
  }

  if (button.repeat) {
    // Auto-repeat path: fire once on pointerdown, then start a delayed
    // interval. Cancel on pointerup/leave/cancel. We suppress the synthesized
    // click so we don't double-fire after an immediate release.
    let delayTimer = null;
    let intervalTimer = null;
    let suppressClick = false;
    const stop = () => {
      if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
      if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    };
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      suppressClick = true;
      onKey(button.code);
      stop();
      delayTimer = setTimeout(() => {
        intervalTimer = setInterval(() => onKey(button.code), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('click', (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
      } else {
        onKey(button.code);
      }
    });
  } else {
    el.addEventListener('click', () => onKey(button.code));
  }
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
    case '≤': return '≤';
    case '≥': return '≥';
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
