// A free-form Hebrew text answer block. Renders as a textarea with RTL
// direction so Hebrew flows naturally. The kid can type directly with the
// system keyboard, or use the in-app Hebrew keypad (which targets whichever
// textarea is currently focused).

export function renderTextBlock(block, options = {}) {
  const wrapper = document.createElement('figure');
  wrapper.className = 'textblock';
  wrapper.dataset.blockId = block.id;

  const ta = document.createElement('textarea');
  ta.className = 'textblock__input';
  ta.dir = 'rtl';
  ta.lang = 'he';
  ta.placeholder = 'הקלד תשובה...';
  ta.value = block.content || '';
  ta.rows = 3;
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.autocomplete = 'off';
  ta.dataset.blockId = block.id;

  // Auto-grow to fit content so a long answer doesn't disappear behind a
  // fixed height. min-height is set in CSS.
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };

  ta.addEventListener('input', () => {
    block.content = ta.value;
    autosize();
    if (options.onChange) options.onChange();
  });

  if (options.onFocus) {
    ta.addEventListener('focus', () => options.onFocus(ta, block));
  }
  if (options.onBlur) {
    ta.addEventListener('blur', () => options.onBlur(ta, block));
  }

  wrapper.appendChild(ta);

  if (options.onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'textblock__delete';
    del.textContent = '✕';
    del.title = 'הסר תיבת טקסט';
    del.setAttribute('aria-label', 'הסר תיבת טקסט');
    del.addEventListener('click', () => options.onDelete(block.id));
    wrapper.appendChild(del);
  }

  // Defer autosize until after the element is attached so scrollHeight is
  // measurable.
  requestAnimationFrame(autosize);

  return wrapper;
}
