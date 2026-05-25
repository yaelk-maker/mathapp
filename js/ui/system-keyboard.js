// Bridge between the iPadOS system keyboard and our layout. When the kid
// taps a real <input> or <textarea> (rename dialog, search, etc.) iPadOS
// raises its on-screen keyboard. By default the layout viewport doesn't
// shrink, so the system keyboard happily covers the bottom of the page —
// which is where our modal dialog input AND the in-app math keypad live.
//
// What this module does on focusin:
//   • Adds body.system-kbd-up so CSS can hide .editor__keypad-host (the
//     math keypad isn't reachable through the system keyboard anyway).
//   • Mirrors visualViewport height/offsetTop into CSS variables so the
//     dialog overlay can pin itself to the top of the visible area.
//   • Smoothly scrolls the focused input into view as a fallback for
//     non-dialog contexts (e.g. the home-screen search input).

let installed = false;

function isFocusableInput(target) {
  if (!target) return false;
  // contenteditable elements (e.g. worksheet annotations) also raise the
  // iPadOS keyboard, so they need the same treatment — without this the
  // in-app math keypad sits on top of the system keyboard with both
  // visible. The .dialog skip below still applies since dialogs anchor
  // themselves.
  if (target.isContentEditable) {
    if (target.closest && target.closest('.dialog')) return false;
    return true;
  }
  const tag = target.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  if (target.type === 'hidden' || target.disabled || target.readOnly) return false;
  // Inputs that live inside a modal dialog are already correctly anchored by
  // the dialog itself — we don't need (or want) the body-level keyboard
  // bridge to repaint their host. Skipping these also avoids a layout
  // shift mid-dialog-render on iPadOS that was making create/rename feel
  // like nothing happened.
  if (target.closest && target.closest('.dialog')) return false;
  return true;
}

export function installSystemKeyboardBridge() {
  if (installed) return;
  installed = true;

  const root = document.documentElement;
  const vv = window.visualViewport;

  const sync = () => {
    if (!vv) return;
    root.style.setProperty('--vv-height', vv.height + 'px');
    root.style.setProperty('--vv-offset-top', vv.offsetTop + 'px');
  };

  if (vv) {
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  document.addEventListener('focusin', (event) => {
    if (!isFocusableInput(event.target)) return;
    document.body.classList.add('system-kbd-up');
    // The system keyboard animates in over ~250ms on iPadOS — wait a beat
    // before scrolling into view so the visualViewport has actually
    // shrunk. Smooth scroll keeps the kid's eye on the input.
    setTimeout(() => {
      try {
        event.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_) {
        // Older Safari ignores the options bag; the unconditional call is
        // already safe enough.
      }
    }, 280);
  });

  document.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (isFocusableInput(next)) return;
    document.body.classList.remove('system-kbd-up');
  });
}
