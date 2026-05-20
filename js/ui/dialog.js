// Hebrew, RTL-correct modal dialogs that replace window.confirm/prompt.
// Native browser dialogs render with English chrome ("OK"/"Cancel") and the
// wrong button order for RTL — confusing for a 12-year-old Hebrew speaker
// and dangerous next to a destructive action.
//
// confirmDialog and promptDialog return Promises. Pressing Escape resolves
// to false / null. Pressing Enter inside a prompt confirms the input.

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  return overlay;
}

function buildDialog() {
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.setAttribute('dir', 'rtl');
  dialog.setAttribute('lang', 'he');
  return dialog;
}

function trapFocus(container) {
  const focusables = container.querySelectorAll(
    'button, input, [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

export function confirmDialog({
  title = '',
  body = '',
  confirmLabel = 'אישור',
  cancelLabel = 'ביטול',
  destructive = false
} = {}) {
  return new Promise((resolve) => {
    const overlay = buildOverlay();
    const dialog = buildDialog();

    const titleEl = document.createElement('h2');
    titleEl.className = 'dialog__title';
    titleEl.textContent = title;

    const bodyEl = document.createElement('p');
    bodyEl.className = 'dialog__body';
    bodyEl.textContent = body;

    const buttons = document.createElement('div');
    buttons.className = 'dialog__buttons';

    // Primary (confirm) on the start side in RTL — right-aligned visually.
    // dialog__buttons uses flex-direction: row-reverse so the first child
    // here renders on the right, matching iOS Hebrew conventions.
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className =
      'dialog__btn ' + (destructive ? 'dialog__btn--danger' : 'dialog__btn--primary');
    confirmBtn.textContent = confirmLabel;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dialog__btn';
    cancelBtn.textContent = cancelLabel;

    buttons.appendChild(confirmBtn);
    buttons.appendChild(cancelBtn);

    if (title) dialog.appendChild(titleEl);
    if (body) dialog.appendChild(bodyEl);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        close(true);
      }
    };

    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    trapFocus(dialog);
    // Cancel is the safer default for destructive prompts, so focus there;
    // for non-destructive confirmations, focus the primary action.
    (destructive ? cancelBtn : confirmBtn).focus();
  });
}

export function promptDialog({
  title = '',
  body = '',
  defaultValue = '',
  confirmLabel = 'שמירה',
  cancelLabel = 'ביטול',
  placeholder = ''
} = {}) {
  return new Promise((resolve) => {
    const overlay = buildOverlay();
    const dialog = buildDialog();

    const titleEl = document.createElement('h2');
    titleEl.className = 'dialog__title';
    titleEl.textContent = title;

    const bodyEl = document.createElement('p');
    bodyEl.className = 'dialog__body';
    bodyEl.textContent = body;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dialog__input';
    input.value = defaultValue;
    if (placeholder) input.placeholder = placeholder;

    const buttons = document.createElement('div');
    buttons.className = 'dialog__buttons';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'dialog__btn dialog__btn--primary';
    confirmBtn.textContent = confirmLabel;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dialog__btn';
    cancelBtn.textContent = cancelLabel;

    buttons.appendChild(confirmBtn);
    buttons.appendChild(cancelBtn);

    if (title) dialog.appendChild(titleEl);
    if (body) dialog.appendChild(bodyEl);
    dialog.appendChild(input);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        close(input.value);
      }
    };

    confirmBtn.addEventListener('click', () => close(input.value));
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    trapFocus(dialog);
    // We deliberately do NOT auto-focus the input here. On iPadOS standalone
    // PWAs, calling .focus() after an awaited promise (the typical caller
    // pattern: await listNotebooks(); promptDialog(...)) is outside a user
    // gesture, so iOS won't actually raise the keyboard — and at least one
    // device shape was reproducibly losing the dialog render entirely on
    // that path. The kid taps the input herself when ready; the keyboard
    // rises on real touch and the bridge in js/ui/system-keyboard.js takes
    // over from there.
  });
}

// Hebrew picker dialog — radio-style list of mutually exclusive options
// (used by the "move notebook to folder" flow). Each option is
// `{ id, label }`. Resolves with the selected id on confirm, undefined on
// cancel. `selectedId` preselects the matching option.
export function pickDialog({
  title = '',
  body = '',
  options = [],
  selectedId = null,
  confirmLabel = 'אישור',
  cancelLabel = 'ביטול'
} = {}) {
  return new Promise((resolve) => {
    const overlay = buildOverlay();
    const dialog = buildDialog();

    const titleEl = document.createElement('h2');
    titleEl.className = 'dialog__title';
    titleEl.textContent = title;

    const bodyEl = document.createElement('p');
    bodyEl.className = 'dialog__body';
    bodyEl.textContent = body;

    const list = document.createElement('div');
    list.className = 'dialog__picker';
    let chosenId = selectedId;
    const itemEls = [];
    for (const opt of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dialog__picker-item';
      // Keep a string-encoded form because dataset values are always strings
      // and we still need to distinguish "" (root) from "id-of-some-folder".
      item.dataset.optId = opt.id == null ? '' : String(opt.id);
      item.textContent = opt.label;
      if ((opt.id || null) === (chosenId || null)) {
        item.classList.add('dialog__picker-item--selected');
      }
      item.addEventListener('click', () => {
        chosenId = opt.id == null ? null : opt.id;
        for (const el of itemEls) {
          el.classList.toggle(
            'dialog__picker-item--selected',
            (el.dataset.optId || '') === (item.dataset.optId || '')
          );
        }
      });
      itemEls.push(item);
      list.appendChild(item);
    }

    const buttons = document.createElement('div');
    buttons.className = 'dialog__buttons';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'dialog__btn dialog__btn--primary';
    confirmBtn.textContent = confirmLabel;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dialog__btn';
    cancelBtn.textContent = cancelLabel;

    buttons.appendChild(confirmBtn);
    buttons.appendChild(cancelBtn);

    if (title) dialog.appendChild(titleEl);
    if (body) dialog.appendChild(bodyEl);
    dialog.appendChild(list);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(undefined);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        close(chosenId);
      }
    };

    confirmBtn.addEventListener('click', () => close(chosenId));
    cancelBtn.addEventListener('click', () => close(undefined));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(undefined);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    trapFocus(dialog);
    confirmBtn.focus();
  });
}

// Lightweight Hebrew toast for non-blocking confirmations like "שוחזרו N
// מחברות". Replaces the alert() calls in main.js so we don't pop the native
// English-chrome banner.
export function toast(message, { duration = 2400, kind = 'info' } = {}) {
  const el = document.createElement('div');
  el.className = 'dialog-overlay';
  el.style.background = 'transparent';
  el.style.pointerEvents = 'none';
  el.style.alignItems = 'flex-start';
  el.style.paddingTop = 'calc(64px + env(safe-area-inset-top))';

  const card = document.createElement('div');
  card.className = 'dialog';
  card.setAttribute('dir', 'rtl');
  card.style.padding = '12px 18px';
  card.style.minWidth = 'auto';
  card.style.fontSize = '15px';
  card.style.fontWeight = '600';
  card.style.boxShadow = '0 6px 22px rgba(0, 0, 0, 0.18)';
  if (kind === 'error') {
    card.style.background = '#fdeceb';
    card.style.color = '#8a1f15';
    card.style.border = '1px solid #c0392b';
  } else if (kind === 'warn') {
    card.style.background = '#fff5e1';
    card.style.color = '#7a4f00';
    card.style.border = '1px solid #e6a700';
  }
  card.textContent = message;

  el.appendChild(card);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// Save errors are the worst kind of silent failure for the kid: ink/digits
// appear on screen but never make it to IndexedDB (quota, transaction
// abort), and on reload the work is gone. We surface a Hebrew toast — but
// throttle to once every SAVE_TOAST_COOLDOWN_MS so a runaway failure loop
// doesn't fill the screen with banners. Prefer this over toast() at every
// call site so the cooldown applies globally.
const SAVE_TOAST_COOLDOWN_MS = 4000;
let lastSaveErrorAt = 0;
export function notifySaveError(message = 'השמירה נכשלה — נסי לגבות את המחברת.') {
  const now = Date.now();
  if (now - lastSaveErrorAt < SAVE_TOAST_COOLDOWN_MS) return;
  lastSaveErrorAt = now;
  toast(message, { kind: 'error', duration: 4200 });
}
