// Notebook editor: a page is a vertical flow of blocks (worksheet images and
// work-grid blocks). The grid is a property of WorkBlocks only — it CANNOT
// bleed under a worksheet image. That is the architectural fix vs. ModMath.
//
// Phase 4 adds an Apple Pencil drawing layer: a single canvas overlay covers
// the entire page area so strokes can cross between worksheet and grid blocks.
// Strokes are stored per-page in IndexedDB.

import {
  listPages,
  getNotebook,
  savePage,
  renameNotebook,
  deleteBlob,
  listStrokesByPage,
  addStroke,
  deleteStrokeById,
  clearStrokesForPage
} from './db.js';
import {
  BLOCK,
  newWorkBlock,
  isComposite,
  compositeSlots,
  isCompositeEmpty,
  compositeWidth,
  findOccupyingAnchor,
  newFractionCell,
  newPowCell,
  newSqrtCell,
  newNRootCell,
  newAbsCell,
  MARGIN_COLS,
  migrateWorkBlockMargin,
  migrateWorkBlockRowLabels,
  migrateWorkBlockSize,
  newAnnotation,
  newGridAnnotation,
  isGridAnnotation,
  newGraphBlock,
  newGraphAnnotation,
  nextExerciseLabel,
  nextRowLabel,
  getAnnotations
} from './page-model.js';
import { renderWorkBlock, updateCell, updateCursor, paintCell } from './render/grid.js';
import { renderGraphBlock } from './render/graph.js';
import {
  renderWorksheetBlock,
  revokeWorksheetUrls,
  revokeBlobUrl
} from './render/worksheet.js';
import {
  sizeCanvas,
  renderStroke,
  renderStrokeIncremental,
  replayStrokes
} from './render/strokes.js';
import { renderKeypad, keyboardEventToCode } from './input/keypad.js';
import { renderHebrewKeypad } from './input/hebrew-keypad.js';
import { renderEnglishKeypad } from './input/english-keypad.js';
import { uploadWorksheet } from './io/import.js';
import { exportSingleNotebookToJSON, shareJSON } from './io/export.js';
import { attachPencilSurface } from './input/pencil.js';
import { confirmDialog, promptDialog, notifySaveError, toast } from './ui/dialog.js';

const CHAR_KEYS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '+', '−', '×', '÷', '=', '.', '(', ')', '%',
  'x', 'y', 'a', 'b',
  '<', '>', '≤', '≥'
]);

// Inside a fraction slot we can't open a nested composite (slots are plain
// strings), but the kid still wants to write things like "x²" or "√2" in a
// numerator. Map POW/SQRT presses to inline unicode marks so they appear in
// the slot text. POW cycles ²→³→⁴ when pressed repeatedly so multiple
// powers are reachable without a dedicated key.
const SUPERSCRIPT_DIGITS = ['²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const SUPERSCRIPT_NEXT = new Map(
  SUPERSCRIPT_DIGITS.map((s, i) => [s, SUPERSCRIPT_DIGITS[(i + 1) % SUPERSCRIPT_DIGITS.length]])
);

const COMPOSITE_KEYS = {
  FRAC: () => newFractionCell(),
  POW: () => newPowCell(),
  // a² shortcut — pre-fills the exponent so the kid doesn't have to type
  // '2' after every square. Treated like POW for promotion of an adjacent
  // atom into the base; insertComposite skips entering the exp slot when
  // exp is already filled (see special-case in insertComposite).
  SQUARE: () => newPowCell('', '2'),
  SQRT: () => newSqrtCell(),
  NROOT: () => newNRootCell(),
  ABS: () => newAbsCell()
};

const SAVE_DEBOUNCE_MS = 300;

const PEN_COLORS = ['#111111', '#0b6cf2', '#d12d2d', '#1f9c4a', '#e6a700'];

export async function mountEditor(root, notebookId) {
  const nb = await getNotebook(notebookId);
  if (!nb) {
    window.location.hash = '';
    return;
  }
  const pages = await listPages(notebookId);
  if (pages.length === 0) {
    window.location.hash = '';
    return;
  }
  const page = pages[0];

  // Fresh notebook bootstrap — seed FIVE exercise blocks instead of
  // one. Most worksheets the kid solves have several questions; pre-
  // creating their work areas lets her start typing immediately on
  // each one instead of pressing "+ תרגיל חדש" four extra times. Each
  // block gets a sequential label (1..5). Old notebooks already have
  // at least one work block, so this branch only runs for true first-
  // loads of a freshly-created notebook.
  if (!page.blocks.some((b) => b.type === BLOCK.WORK)) {
    for (let i = 1; i <= 5; i += 1) {
      page.blocks.push(newWorkBlock({ label: String(i) }));
    }
    await savePage(page);
  }

  // One-time per-block migrations:
  //   1. Shift cells out of the reserved notebook margin (cols 0..MARGIN_COLS-1)
  //      — content from before the margin feature existed.
  //   2. Shrink rows/cols toward the new (smaller) DEFAULT_GRID so the kid
  //      gets visibly bigger cells without losing work. Order matters:
  //      margin migration runs first because it can grow cols, then size
  //      migration trims them back if the new max fits.
  //   3. Backfill exercise labels on work blocks that pre-date the
  //      Exercise-label feature: assign sequential "1", "2", … in the
  //      order the blocks appear on the page. The kid edits the first
  //      label if their worksheet starts somewhere else; subsequent
  //      additions auto-increment from whatever's already there.
  {
    let migrated = false;
    let exerciseCounter = 1;
    for (const block of page.blocks) {
      if (block.type === BLOCK.WORK) {
        if (migrateWorkBlockMargin(block)) migrated = true;
        if (migrateWorkBlockSize(block)) migrated = true;
        if (migrateWorkBlockRowLabels(block)) migrated = true;
        if (block.label == null) {
          block.label = String(exerciseCounter);
          migrated = true;
        }
        exerciseCounter += 1;
      } else if (block.type === BLOCK.WORKSHEET && Array.isArray(block.annotations)) {
        // Prune annotations that were created (often by stray taps in
        // annotate mode) but never typed into. Pre-cleanup notebooks
        // accumulated visible "הקלידי…" placeholders all over the
        // worksheet because empty annotations persisted across saves.
        // Future empties auto-delete on blur via worksheet.js; this
        // catches the legacy ones. Grid annotations are kept regardless
        // of content — they're a deliberate UI element (the kid taps
        // to create one and may have left it empty momentarily).
        const before = block.annotations.length;
        block.annotations = block.annotations.filter(
          (a) => isGridAnnotation(a) ||
                 (a.text && a.text.length > 0) ||
                 (typeof a.html === 'string' && a.html.length > 0)
        );
        if (block.annotations.length !== before) migrated = true;
      }
    }
    if (migrated) await savePage(page);
  }

  // cursor.slot is null when in main grid; otherwise the active slot name of
  // a composite cell at (r, c) — e.g. 'num', 'den', 'base', 'exp', 'radicand'.
  // c starts at MARGIN_COLS so the cursor never lands inside the reserved
  // notebook margin on the left of the grid.
  const cursor = { r: 0, c: MARGIN_COLS, slot: null };
  let activeWorkBlock = page.blocks.find((b) => b.type === BLOCK.WORK);
  let activeGrid = null;

  // Split-view paired-section model: the page is grouped into "sections"
  // by worksheet boundaries — every worksheet starts a new section, and
  // subsequent non-worksheet blocks belong to it until the next worksheet.
  // In split mode only the active section is rendered (other sections are
  // hidden via the block--inactive-section class), and a centered pager
  // above the page flips through sections. This way the kid moves through
  // the worksheet AND its corresponding workblock as a single "page" —
  // they never end up looking at worksheet 2 next to workblock 1.
  let activeSectionIndex = 0;
  // Land on the section that contains the kid's actual workblock so old
  // notebooks (where every worksheet was inserted ahead of the single
  // shared workblock, leaving section 0 as just an image with no place
  // to type) don't open on an empty page. The pager still works either
  // way; this just picks a better default.
  {
    const initialSections = computeSections();
    if (activeWorkBlock) {
      const idx = initialSections.findIndex((s) => s.includes(activeWorkBlock));
      if (idx >= 0) activeSectionIndex = idx;
    }
  }

  // Annotate mode: when set, tapping an empty area of a worksheet image
  // drops a new annotation of that kind at that point. Off (null) by
  // default; the kid toggles it with the 🔢 / 📝 toolbar buttons.
  // Mutually exclusive with pen mode — drawing and typing-on-paper
  // compete for the same gesture. Two kinds:
  //   'grid' — a small grid-cell annotation for calculations. Default.
  //   'text' — a free-text contenteditable for written notes.
  let annotateKind = null;

  // Active grid-annotation focus. When set, the in-app keypad routes
  // its presses into the annotation's cells instead of the work block.
  // Cleared when the kid taps a workblock cell or focuses a text
  // annotation — the focus targets are mutually exclusive.
  let activeGridAnnot = null;

  // Active row-label popover. Carries the workblock id + row number
  // and a reference to the floating editor DOM. While set, the in-app
  // keypad routes presses into the popover's contenteditable instead
  // of the workblock grid (mutually exclusive with activeGridAnnot
  // and grid-cell focus). Cleared on Enter / outside-tap / Esc.
  let activeRowLabel = null;

  // When the kid focuses a worksheet annotation, the in-app keypad routes
  // its presses to insert text at the caret instead of into the active
  // work-block cell. We discover the focused element by walking
  // document.activeElement (rather than caching it) so a re-render that
  // rebuilds the DOM doesn't leave us holding a stale node reference.
  // The contenteditable suppresses the iPadOS keyboard via
  // inputmode="none", and keypad buttons preventDefault on mousedown to
  // avoid stealing focus from it.
  //
  // Returns the focused editable element, which may be the annotation
  // root OR a nested editable slot like a fraction's numerator/
  // denominator. Returns null when focus is elsewhere on the page.
  function getFocusedAnnotation() {
    const el = document.activeElement;
    if (!el || !el.closest) return null;
    if (!el.closest('.worksheet__annot')) return null;
    if (!el.isContentEditable) return null;
    return el;
  }

  // Keypad mode: 'math' (default), 'hebrew' or 'english'. Letter modes swap
  // in their respective on-screen layouts and route presses into the active
  // work block's grid (one letter per cell, just like math digits).
  //
  // Toggling: every keypad carries a single globe key (TOGGLE_KEYPAD) that
  // cycles through the modes in KEYPAD_CYCLE order — like the iPadOS globe.
  // math → hebrew → english → math. Hebrew comes first out of math because
  // the kid is a Hebrew-first speaker, and any mode is reachable in at most
  // two taps.
  let keypadMode = 'math';
  const KEYPAD_CYCLE = ['math', 'hebrew', 'english'];
  function nextKeypadMode() {
    const i = KEYPAD_CYCLE.indexOf(keypadMode);
    return KEYPAD_CYCLE[(i + 1) % KEYPAD_CYCLE.length];
  }

  // Drawing state
  const strokes = await listStrokesByPage(page.id);
  let pencilEnabled = false;
  let eraserMode = false;
  // Highlighter ("מרקר") mode: same pen surface, but strokes are wide and
  // semi-transparent so they mark over text/digits without hiding them.
  let markerMode = false;
  let penColor = PEN_COLORS[0];
  const penWidth = 2.4;
  // Marker strokes are much wider than the pen so a single pass covers a
  // line of math; the see-through look comes from the alpha applied in
  // strokes.js, not from the width.
  const MARKER_WIDTH = 18;
  let canvas = null;
  let ctx = null;
  let detachPencil = null;
  const liveStrokes = new Map(); // strokeId -> stroke being drawn
  const liveDrawnPointCount = new Map(); // strokeId -> last drawn index
  // Block offset captured at stroke start. The block can't move during a
  // single stroke (the user is drawing on it), so caching at start lets us
  // translate incoming points to block-relative coords without re-measuring
  // the DOM on every pointermove.
  const liveStrokeOffsets = new Map(); // strokeId -> { x, y }
  // In-flight stroke save promises. Cleanup must await these so the kid never
  // loses a stroke by tapping "back" right after lifting the Pencil.
  const pendingStrokeSaves = new Set();

  root.innerHTML = `
    <div class="editor editor--full editor--chrome-collapsed">
      <button class="editor__chrome-toggle" id="chrome-toggle" type="button"
              aria-label="הצג סרגל כלים" title="הצג סרגל כלים">≡</button>
      <div class="editor__chrome" id="editor-chrome">
        <div class="editor__topbar">
          <button class="editor__back" id="back-home" aria-label="חזרה">← <span class="label">חזרה</span></button>
          <h2 class="editor__title" id="title"></h2>
          <button class="btn btn--ghost" id="rename"><span class="label">שנה שם</span></button>
        </div>
        <div class="editor__actions">
          <button class="btn btn--ghost" id="undo-edit" aria-label="ביטול פעולה" title="ביטול פעולה אחרונה" disabled>↺ <span class="label">ביטול</span></button>
          <span class="editor__sep"></span>
          <button class="btn btn--ghost" id="upload-library" aria-label="צילום או בחירת קובץ" title="צילום, תמונה או PDF">📷 <span class="label">דף</span></button>
          <button class="btn btn--ghost" id="toggle-annotate-grid" aria-label="חישוב על דף" title="חישוב על דף — הקישי כאן ואז על הדף כדי להוסיף תיבת חישוב">🔢 <span class="label">חישוב על דף</span></button>
          <button class="btn btn--ghost" id="toggle-annotate-text" aria-label="טקסט על דף" title="טקסט על דף — הקישי כאן ואז על הדף כדי להוסיף תיבת טקסט">📝 <span class="label">טקסט על דף</span></button>
          <button class="btn btn--ghost" id="toggle-annotate-graph" aria-label="גרף על דף" title="גרף על דף — הקישי כאן ואז על הדף כדי להוסיף מערכת צירים">📈 <span class="label">גרף על דף</span></button>
          <button class="btn btn--ghost" id="add-work" aria-label="תרגיל חדש">➕ <span class="label">תרגיל חדש</span></button>
          <button class="btn btn--ghost" id="add-graph" aria-label="גרף" title="הוספת מערכת צירים — לסימון נקודות (x, y)">📈 <span class="label">גרף</span></button>
          <button class="btn btn--ghost" id="toggle-split" aria-label="פיצול">🔀 <span class="label">פיצול</span></button>
          <button class="btn btn--ghost" id="toggle-share" aria-label="שיתוף וייצוא" title="הדפסה, שמירה כ-PDF וגיבוי" aria-expanded="false">📤 <span class="label">שיתוף</span></button>
          <span class="share-tools" id="share-tools" hidden>
            <button class="btn btn--ghost" id="print-page" aria-label="הדפסה ושמירה כ-PDF" title="הדפסה, או שמירה כ-PDF ושיתוף דרך אפשרויות ה-iPad">🖨️ <span class="label">הדפסה / PDF</span></button>
            <button class="btn btn--ghost" id="backup-notebook" aria-label="גיבוי המחברת" title="גיבוי המחברת לקובץ ושיתוף">💾 <span class="label">גיבוי</span></button>
          </span>
          <span class="editor__sep"></span>
          <button class="btn btn--ghost" id="toggle-grid-tools" aria-label="שורות ועמודות" title="הוספה ומחיקה של שורות ועמודות" aria-expanded="false">▦ <span class="label">שורות ועמודות</span></button>
          <span class="grid-tools" id="grid-tools" hidden>
            <button class="btn btn--ghost" id="row-insert" aria-label="הוספת שורה">➕↕ <span class="label">שורה</span></button>
            <button class="btn btn--ghost" id="row-delete" aria-label="מחיקת שורה">➖↕ <span class="label">שורה</span></button>
            <button class="btn btn--ghost" id="col-insert" aria-label="הוספת עמודה">➕↔ <span class="label">עמודה</span></button>
            <button class="btn btn--ghost" id="col-delete" aria-label="מחיקת עמודה">➖↔ <span class="label">עמודה</span></button>
          </span>
          <span class="editor__sep"></span>
          <button class="btn btn--ghost" id="toggle-pen" aria-label="ציור">✏️ <span class="label">ציור</span></button>
          <span class="pen-tools" id="pen-tools" hidden>
            ${PEN_COLORS.map(
              (c, i) => `<button class="pen-color ${i === 0 ? 'pen-color--active' : ''}"
                style="background:${c}" data-color="${c}" aria-label="צבע"></button>`
            ).join('')}
            <button class="btn btn--ghost" id="toggle-marker" aria-label="מרקר" title="מרקר — סימון בהדגשה שקופה מעל הכתוב">🖍️ <span class="label">מרקר</span></button>
            <button class="btn btn--ghost" id="toggle-eraser" aria-label="מחק">🧽 <span class="label">מחק</span></button>
            <button class="btn btn--ghost" id="undo-stroke" aria-label="בטל">↺ <span class="label">בטל</span></button>
            <button class="btn btn--ghost" id="clear-strokes" aria-label="נקה ציורים">🗑️ <span class="label">נקה ציורים</span></button>
          </span>
        </div>
        <button class="editor__chrome-pin" id="chrome-pin" type="button"
                aria-label="נעץ סרגל" title="נעץ את הסרגל פתוח">📌</button>
        <button class="editor__chrome-close" id="chrome-close" type="button"
                aria-label="סגור סרגל כלים" title="סגור סרגל כלים">×</button>
      </div>
      <div class="editor__section-bar" id="section-bar" hidden dir="rtl">
        <!-- dir="rtl" places "previous" (קודם) visually on the right and
             "next" (הבא) on the left, matching Hebrew page flow. Labels
             are Hebrew text rather than ‹›, which were tiny and
             directionally ambiguous on RTL pages. -->
        <button type="button" class="editor__section-btn" data-dir="prev"
                aria-label="עמוד קודם" title="עמוד קודם">קודם</button>
        <span class="editor__section-count" id="section-count">1 / 1</span>
        <button type="button" class="editor__section-btn" data-dir="next"
                aria-label="עמוד הבא" title="עמוד הבא">הבא</button>
      </div>
      <div class="editor__page" id="page-scroll">
        <div class="pen-mode-indicator">✏️ מצב ציור פעיל</div>
        <div class="editor__page-content" id="page-content">
          <div id="page"></div>
          <canvas class="pencil-canvas" id="pencil-canvas"></canvas>
        </div>
      </div>
      <div class="editor__keypad-host" id="keypad-host">
        <button class="editor__keypad-handle" id="keypad-handle" type="button"
                aria-label="כווץ מקלדת" title="גרור מטה כדי לסגור">▾</button>
        <div id="keypad-host-inner"></div>
      </div>
      <button class="editor__keypad-show" id="keypad-show" type="button"
              aria-label="הצג מקלדת" title="הצג מקלדת" hidden>⌨</button>
    </div>
  `;

  document.getElementById('title').textContent = nb.name;
  document.getElementById('back-home').addEventListener('click', async () => {
    detachPencilIfAny();
    // Wait for both pending page saves AND in-flight stroke saves before
    // navigating away — otherwise a typed digit or a lifted Pencil can be
    // lost between the action and the IDB write committing.
    await Promise.all([
      flushSave(),
      Promise.allSettled([...pendingStrokeSaves])
    ]);
    revokeWorksheetUrls();
    window.location.hash = '';
  });
  document.getElementById('rename').addEventListener('click', async () => {
    const name = await promptDialog({
      title: 'שינוי שם',
      body: 'שם חדש למחברת:',
      defaultValue: nb.name,
      confirmLabel: 'שמירה'
    });
    if (name == null || !name.trim() || name.trim() === nb.name) return;
    await renameNotebook(notebookId, name.trim());
    document.getElementById('title').textContent = name.trim();
    nb.name = name.trim();
  });

  // Single image entry point — capture:false lets the picker offer both
  // "Take Photo" and "Photo Library" on iPadOS, so the kid doesn't need a
  // separate camera-only button.
  document.getElementById('upload-library').addEventListener('click', () =>
    addWorksheet({ capture: false })
  );
  document.getElementById('add-work').addEventListener('click', () => addWorkBlock());
  document.getElementById('add-graph').addEventListener('click', () => addGraphBlock());

  // "Add a box on the page" buttons — one for a calculation grid
  // (חישוב על דף), one for free text (טקסט על דף). Both share ONE
  // creation method: press the button to arm, then tap once on the
  // worksheet to drop a single box where you tapped. The box auto-disarms
  // after that one tap (see createAnnotation), so brushing the page never
  // spawns extra boxes — the kid presses the button again for each new
  // box. The two kinds are mutually exclusive with each other AND with
  // pen mode (the pencil canvas claims pointer events while active, which
  // would swallow the placement tap).
  const annotateGridBtn = document.getElementById('toggle-annotate-grid');
  const annotateTextBtn = document.getElementById('toggle-annotate-text');
  const annotateGraphBtn = document.getElementById('toggle-annotate-graph');
  function setAnnotateKind(kind) {
    annotateKind = kind;
    annotateGridBtn.classList.toggle('btn--active', kind === 'grid');
    annotateTextBtn.classList.toggle('btn--active', kind === 'text');
    annotateGraphBtn.classList.toggle('btn--active', kind === 'graph');
    if (kind && pencilEnabled) {
      // Drop pen mode silently — the kid asked for typing, the explicit
      // toggle is more recent intent than the still-active pen state.
      setPencilEnabled(false);
    }
    if (kind) {
      toast(
        kind === 'grid'
          ? 'הקישי על הדף במקום שבו תרצי את תיבת החישוב'
          : kind === 'graph'
            ? 'הקישי על הדף במקום שבו תרצי את מערכת הצירים'
            : 'הקישי על הדף במקום שבו תרצי את תיבת הטקסט',
        { kind: 'info' }
      );
    }
    renderBlocks();
  }
  // Leave armed mode without re-rendering — createAnnotation calls this the
  // moment a box lands so the very next tap on the worksheet doesn't drop a
  // second box. The render that follows the placement clears the crosshair.
  function disarmAnnotate() {
    if (!annotateKind) return;
    annotateKind = null;
    annotateGridBtn.classList.remove('btn--active');
    annotateTextBtn.classList.remove('btn--active');
    annotateGraphBtn.classList.remove('btn--active');
  }
  annotateGridBtn.addEventListener('click', () => {
    setAnnotateKind(annotateKind === 'grid' ? null : 'grid');
  });
  annotateTextBtn.addEventListener('click', () => {
    setAnnotateKind(annotateKind === 'text' ? null : 'text');
  });
  annotateGraphBtn.addEventListener('click', () => {
    setAnnotateKind(annotateKind === 'graph' ? null : 'graph');
  });

  // Section pager (centered above the page in split mode). Each arrow
  // moves both the worksheet AND its paired workblock together, so the
  // kid sees the page-N worksheet next to the page-N work area.
  document.getElementById('section-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]');
    if (!btn) return;
    const delta = btn.dataset.dir === 'prev' ? -1 : 1;
    setActiveSection(activeSectionIndex + delta);
  });

  // Split-view toggle: in split mode the worksheet sits next to the work
  // block (instead of above). Persisted in localStorage so the preference
  // sticks across sessions.
  const editorEl = root.querySelector('.editor--full');
  const splitToggleBtn = document.getElementById('toggle-split');
  let splitMode = localStorage.getItem('mathapp.splitMode') === '1';
  editorEl.classList.toggle('editor--split', splitMode);
  splitToggleBtn.classList.toggle('btn--active', splitMode);
  splitToggleBtn.addEventListener('click', () => {
    splitMode = !splitMode;
    localStorage.setItem('mathapp.splitMode', splitMode ? '1' : '0');
    editorEl.classList.toggle('editor--split', splitMode);
    splitToggleBtn.classList.toggle('btn--active', splitMode);
    // Re-render so the section's active/inactive classes match the new
    // mode. Without this, a cross-section cell tap made in non-split
    // would leave the wrong section marked active when split flips on,
    // and the kid would see the wrong worksheet+workblock pair. The
    // renderBlocks tail already schedules the canvas resize+replay.
    renderBlocks();
  });

  // Insert / delete row / column at the cursor's current position. Each acts
  // on the active work block and refuses (with a brief toast) when the
  // resulting size would be outside the resize-handle bounds (2..40).
  document.getElementById('row-insert').addEventListener('click', () =>
    insertRowAtCursor()
  );
  document.getElementById('row-delete').addEventListener('click', () =>
    deleteRowAtCursor()
  );
  document.getElementById('col-insert').addEventListener('click', () =>
    insertColAtCursor()
  );
  document.getElementById('col-delete').addEventListener('click', () =>
    deleteColAtCursor()
  );

  // Row/column controls used to be four buttons sitting permanently in the
  // toolbar, which ate a lot of width. They now live in a small group that
  // stays collapsed behind one "שורות ועמודות" button (mirroring how the
  // pen tools reveal behind ✏️), so the bar is far less crowded.
  const gridToolsEl = document.getElementById('grid-tools');
  const gridToolsBtn = document.getElementById('toggle-grid-tools');
  gridToolsBtn.addEventListener('click', () => {
    const show = gridToolsEl.hidden;
    gridToolsEl.hidden = !show;
    gridToolsBtn.classList.toggle('btn--active', show);
    gridToolsBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
  });

  // Print: snapshot the canvas as an <img> in place so drawings make it
  // into the PDF (browsers don't reliably print absolute-positioned canvas).
  let printSnapshotImg = null;
  // Tracks whether the current print pass came from the 📄 PDF button so
  // the beforeprint/afterprint listeners know to also drop+restore split
  // mode. Set synchronously by the 📄 click handler RIGHT BEFORE
  // window.print() — the events fire inside print() in the same task, so
  // the flag is always observed.
  let pdfPrintIntent = false;
  let pdfPrintSplitWasOn = false;
  function injectPrintSnapshot() {
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      printSnapshotImg = document.createElement('img');
      printSnapshotImg.className = 'pencil-print-snapshot';
      printSnapshotImg.src = dataUrl;
      printSnapshotImg.style.position = 'absolute';
      printSnapshotImg.style.top = canvas.style.top;
      printSnapshotImg.style.left = canvas.style.left;
      printSnapshotImg.style.width = canvas.style.width;
      printSnapshotImg.style.height = canvas.style.height;
      printSnapshotImg.style.pointerEvents = 'none';
      canvas.parentElement.appendChild(printSnapshotImg);
      canvas.style.visibility = 'hidden';
    } catch (err) {
      console.warn('Could not snapshot canvas for print:', err);
    }
  }
  function removePrintSnapshot() {
    if (printSnapshotImg) {
      printSnapshotImg.remove();
      printSnapshotImg = null;
    }
    if (canvas) canvas.style.visibility = '';
  }
  // beforeprint also drops split mode for PDF prints so the snapshot
  // contains every section (in split mode the CSS hides
  // .block--inactive-section). Running this here — not in the click
  // handler — keeps the click→print() call chain a single sync line,
  // which iPadOS Safari requires to keep the user-activation token
  // alive and avoid the "automatic printing blocked" dialog.
  function applyPdfPrintLayout() {
    if (!pdfPrintIntent) return;
    pdfPrintSplitWasOn = splitMode;
    if (pdfPrintSplitWasOn) {
      editorEl.classList.remove('editor--split');
    }
  }
  function restorePdfPrintLayout() {
    if (!pdfPrintIntent) return;
    pdfPrintIntent = false;
    if (pdfPrintSplitWasOn) {
      editorEl.classList.add('editor--split');
    }
    pdfPrintSplitWasOn = false;
  }
  window.addEventListener('beforeprint', injectPrintSnapshot);
  window.addEventListener('beforeprint', applyPdfPrintLayout);
  window.addEventListener('afterprint', removePrintSnapshot);
  window.addEventListener('afterprint', restorePdfPrintLayout);

  // Share / export menu: one toolbar button (📤) reveals print/PDF + backup,
  // grouped because both are "do something with this whole notebook" actions
  // (mirrors how the pen and row/column tools reveal behind their buttons).
  const shareToolsEl = document.getElementById('share-tools');
  const shareToggleBtn = document.getElementById('toggle-share');
  function setShareToolsOpen(open) {
    shareToolsEl.hidden = !open;
    shareToggleBtn.classList.toggle('btn--active', open);
    shareToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  shareToggleBtn.addEventListener('click', () => setShareToolsOpen(shareToolsEl.hidden));

  // Printing / "save as PDF" is the same iPadOS flow: window.print() opens
  // the native print sheet, whose top share button saves a PDF into Files /
  // AirDrop / Mail. The click handler is intentionally just three statements:
  // set the intent flag (so the beforeprint / afterprint listeners drop +
  // restore split mode and the output contains every section), flush saves
  // (no await), call print(). It runs synchronously inside the real tap so
  // Safari keeps the user-activation token and doesn't block print().
  document.getElementById('print-page').addEventListener('click', () => {
    setShareToolsOpen(false);
    pdfPrintIntent = true;
    flushSave();
    window.print();
  });

  // Backup this notebook to a JSON file and hand it to the iPad share sheet
  // (Files / AirDrop / Drive). Moved here from the home-screen card so all
  // "export this notebook" actions live together in the share menu.
  document.getElementById('backup-notebook').addEventListener('click', async () => {
    setShareToolsOpen(false);
    try {
      await flushSave();
      const data = await exportSingleNotebookToJSON(notebookId);
      const stamp = new Date().toISOString().slice(0, 10);
      const safeName = (nb.name || 'notebook')
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .slice(0, 40);
      await shareJSON(data, `mathapp-${safeName}-${stamp}.json`);
    } catch (err) {
      console.error('Single-notebook backup failed:', err);
      await confirmDialog({
        title: 'הגיבוי נכשל',
        body: 'נסי שוב מאוחר יותר.',
        confirmLabel: 'אישור',
        cancelLabel: 'סגירה'
      });
    }
  });

  // Pencil toolbar wiring. Pen mode also auto-collapses the math keypad —
  // it isn't used while drawing and reclaiming that ~40% of vertical space
  // is the single biggest win in split view.
  const penToolsEl = document.getElementById('pen-tools');
  const penToggleBtn = document.getElementById('toggle-pen');
  function setPencilEnabled(on) {
    pencilEnabled = on;
    penToggleBtn.classList.toggle('btn--active', pencilEnabled);
    penToolsEl.hidden = !pencilEnabled;
    if (canvas) canvas.classList.toggle('pencil-canvas--active', pencilEnabled);
    setKeypadCollapsed(pencilEnabled);
    // Mutex with annotate mode — the pencil canvas captures pointer events
    // for the whole page while active, so annotation taps wouldn't reach
    // their overlay. Drop annotate when pen comes on, and re-render so the
    // worksheet sheds its .worksheet--annotate class.
    if (pencilEnabled && annotateKind) {
      annotateKind = null;
      annotateGridBtn.classList.remove('btn--active');
      annotateTextBtn.classList.remove('btn--active');
      renderBlocks();
    }
    requestAnimationFrame(() => resizeAndReplay());
  }
  penToggleBtn.addEventListener('click', () => setPencilEnabled(!pencilEnabled));

  // AbortController so every global listener added by this mount can
  // be torn down together in cleanup. Without this, opening and closing
  // notebooks accumulates stale pointerover/pointerdown/beforeunload/
  // pagehide/visibilitychange handlers — each holding a reference to a
  // dead `setPencilEnabled` and a dead canvas. Persistence QA flagged
  // this as a memory leak + behavioral risk (pen-hover after a notebook
  // switch would call setPencilEnabled on the OLD closure).
  const mountListeners = new AbortController();
  const mountSignal = mountListeners.signal;

  // Auto-detect Apple Pencil hover/touch. iPadOS 14+ fires pointer events
  // with pointerType="pen" both when the Pencil is hovering ~2 cm above
  // the screen AND when it touches down. Either signal means the kid is
  // intending to draw, so flip pen mode on automatically. We DON'T
  // auto-disable; the kid taps ✏️ off when done.
  //
  // Guard: if the kid currently has caret-in-annotation, do NOT flip
  // pen mode — setPencilEnabled toggles annotateMode and re-renders,
  // which would destroy the focused annotation's DOM mid-edit.
  // (Annotations QA bug.)
  const isAnnotationActive = () => {
    const el = document.activeElement;
    return !!(el && el.closest && el.closest('.worksheet__annot'));
  };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'pen' && !pencilEnabled && !isAnnotationActive()) {
      setPencilEnabled(true);
    }
  }, { capture: true, signal: mountSignal });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen' && !pencilEnabled && !isAnnotationActive()) {
      setPencilEnabled(true);
    }
  }, { capture: true, signal: mountSignal });

  const eraserBtn = document.getElementById('toggle-eraser');
  const markerBtn = document.getElementById('toggle-marker');
  // Eraser and marker are mutually exclusive — each click turns the other
  // off so the kid is never secretly in two modes at once.
  eraserBtn.addEventListener('click', () => {
    eraserMode = !eraserMode;
    if (eraserMode && markerMode) {
      markerMode = false;
      markerBtn.classList.remove('btn--active');
    }
    eraserBtn.classList.toggle('btn--active', eraserMode);
  });
  markerBtn.addEventListener('click', () => {
    markerMode = !markerMode;
    if (markerMode && eraserMode) {
      eraserMode = false;
      eraserBtn.classList.remove('btn--active');
    }
    markerBtn.classList.toggle('btn--active', markerMode);
  });

  document.getElementById('undo-stroke').addEventListener('click', undoLastStroke);
  document.getElementById('clear-strokes').addEventListener('click', clearAllStrokes);

  for (const swatch of penToolsEl.querySelectorAll('.pen-color')) {
    swatch.addEventListener('click', () => {
      penColor = swatch.dataset.color;
      penToolsEl
        .querySelectorAll('.pen-color')
        .forEach((s) => s.classList.toggle('pen-color--active', s === swatch));
    });
  }

  const pageHost = document.getElementById('page');
  const pageContent = document.getElementById('page-content');
  canvas = document.getElementById('pencil-canvas');
  ctx = canvas.getContext('2d');

  await renderBlocks();

  const keypadHost = document.getElementById('keypad-host-inner');

  function mountKeypad() {
    keypadHost.innerHTML = '';
    // Reset the mode-tint classes before applying the active one so jumping
    // straight from Hebrew to English (or vice-versa) doesn't leave a stale
    // tint on the toggle key.
    editorEl.classList.remove('editor--hebrew-mode', 'editor--english-mode');
    if (keypadMode === 'hebrew') {
      keypadHost.appendChild(renderHebrewKeypad({ onKey: handleHebrewKey }));
      editorEl.classList.add('editor--hebrew-mode');
    } else if (keypadMode === 'english') {
      keypadHost.appendChild(renderEnglishKeypad({ onKey: handleEnglishKey }));
      editorEl.classList.add('editor--english-mode');
    } else {
      keypadHost.appendChild(renderKeypad({ onKey: handleKey }));
    }
  }

  // ---- Chrome (topbar+actions) auto-hide ----
  // The chrome eats two rows in split view. Hide it by default and let the
  // kid open it on demand via the floating ≡ button. Re-collapses after a
  // few seconds of no interaction — unless the kid pins it open with 📌.
  const chromeEl = document.getElementById('editor-chrome');
  const chromeToggleBtn = document.getElementById('chrome-toggle');
  const chromeCloseBtn = document.getElementById('chrome-close');
  const chromePinBtn = document.getElementById('chrome-pin');
  let chromeAutoHideTimer = null;
  const CHROME_AUTOHIDE_MS = 4000;
  let chromePinned = localStorage.getItem('mathapp.chromePinned') === '1';
  // Pinned chrome starts open; otherwise the editor's static class
  // editor--chrome-collapsed keeps it closed until the kid opens it.
  if (chromePinned) editorEl.classList.remove('editor--chrome-collapsed');
  chromePinBtn.classList.toggle('btn--active', chromePinned);
  chromePinBtn.setAttribute('aria-pressed', chromePinned ? 'true' : 'false');
  function setChromeOpen(open) {
    // Pinned: stay open. Manual close still works (user can unpin via 📌
    // and then close, or just toggle pin off).
    if (chromePinned && !open) return;
    editorEl.classList.toggle('editor--chrome-collapsed', !open);
    chromeToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (chromeAutoHideTimer) {
      clearTimeout(chromeAutoHideTimer);
      chromeAutoHideTimer = null;
    }
    if (open && !chromePinned) {
      chromeAutoHideTimer = setTimeout(() => {
        editorEl.classList.add('editor--chrome-collapsed');
        chromeAutoHideTimer = null;
      }, CHROME_AUTOHIDE_MS);
    }
    requestAnimationFrame(() => resizeAndReplay());
  }
  chromeToggleBtn.addEventListener('click', () =>
    setChromeOpen(editorEl.classList.contains('editor--chrome-collapsed'))
  );
  chromeCloseBtn.addEventListener('click', () => setChromeOpen(false));
  chromePinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chromePinned = !chromePinned;
    localStorage.setItem('mathapp.chromePinned', chromePinned ? '1' : '0');
    chromePinBtn.classList.toggle('btn--active', chromePinned);
    chromePinBtn.setAttribute('aria-pressed', chromePinned ? 'true' : 'false');
    if (chromePinned) {
      // Pin while open: cancel pending auto-hide so it doesn't close.
      if (chromeAutoHideTimer) {
        clearTimeout(chromeAutoHideTimer);
        chromeAutoHideTimer = null;
      }
      editorEl.classList.remove('editor--chrome-collapsed');
    } else {
      // Unpinning while chrome is visible: restart the auto-hide grace
      // period so the chrome doesn't disappear out from under the kid.
      setChromeOpen(true);
    }
  });
  // Any click inside the chrome restarts the auto-hide timer so the kid
  // doesn't lose the toolbar mid-task.
  chromeEl.addEventListener('pointerdown', () => {
    if (!editorEl.classList.contains('editor--chrome-collapsed')) {
      // refresh timer
      setChromeOpen(true);
    }
  });

  // ---- Keypad collapse (pen mode + manual handle) ----
  const keypadHandleBtn = document.getElementById('keypad-handle');
  const keypadShowBtn = document.getElementById('keypad-show');
  function setKeypadCollapsed(collapsed) {
    editorEl.classList.toggle('editor--keypad-collapsed', collapsed);
    keypadShowBtn.hidden = !collapsed;
    requestAnimationFrame(() => resizeAndReplay());
  }
  keypadHandleBtn.addEventListener('click', () => setKeypadCollapsed(true));
  keypadShowBtn.addEventListener('click', () => setKeypadCollapsed(false));
  // Drag the handle down to dismiss — feels native on iPadOS.
  let handleDragStartY = null;
  keypadHandleBtn.addEventListener('pointerdown', (e) => {
    handleDragStartY = e.clientY;
  });
  keypadHandleBtn.addEventListener('pointermove', (e) => {
    if (handleDragStartY == null) return;
    if (e.clientY - handleDragStartY > 24) {
      setKeypadCollapsed(true);
      handleDragStartY = null;
    }
  });
  const endHandleDrag = () => { handleDragStartY = null; };
  keypadHandleBtn.addEventListener('pointerup', endHandleDrag);
  keypadHandleBtn.addEventListener('pointercancel', endHandleDrag);

  function setKeypadMode(mode) {
    if (mode === keypadMode) return;
    keypadMode = mode;
    // Move the cursor to the side the new keypad writes from — right edge for
    // RTL Hebrew, left (first writable column) for LTR math/English — so the
    // kid starts typing from the correct margin without repositioning by hand.
    if (activeWorkBlock) {
      cursor.slot = null;
      moveCursor(cursor.r, mode === 'hebrew' ? activeWorkBlock.cols - 1 : MARGIN_COLS);
    }
    mountKeypad();
    requestAnimationFrame(() => resizeAndReplay());
  }

  mountKeypad();

  // Set up pencil surface and replay existing strokes
  setupPencilSurface();
  resizeAndReplay();

  const resizeObserver = new ResizeObserver(() => resizeAndReplay());
  resizeObserver.observe(pageHost);
  window.addEventListener('resize', resizeAndReplay);

  const keydownHandler = (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const code = keyboardEventToCode(event);
    if (!code) return;
    event.preventDefault();
    handleKey(code);
  };
  document.addEventListener('keydown', keydownHandler);

  const cleanup = () => {
    document.removeEventListener('keydown', keydownHandler);
    window.removeEventListener('resize', resizeAndReplay);
    window.removeEventListener('beforeprint', injectPrintSnapshot);
    window.removeEventListener('afterprint', removePrintSnapshot);
    // Tear down every listener that was added with { signal: mountSignal }
    // — the pen auto-detect handlers and the lifecycle flush handlers.
    // Without this, navigating away from a notebook leaks them across
    // subsequent mounts (Persistence QA).
    mountListeners.abort();
    resizeObserver.disconnect();
    detachPencilIfAny();
    flushSave();
    revokeWorksheetUrls();
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup, { once: true });

  // ---------- block rendering ----------

  async function renderBlocks() {
    pageHost.innerHTML = '';
    activeGrid = null;
    const workBlocks = page.blocks.filter((b) => b.type === BLOCK.WORK);
    const canDeleteWork = workBlocks.length > 1;
    // Sections = worksheet-bounded groups of blocks. The pager bar above
    // the page flips between them in split mode. activeSectionIndex is
    // authoritative — pager clicks set it directly, cell taps sync it
    // inside onCellTap. We never re-derive it here from activeWorkBlock,
    // because the user can pager to a worksheet-only section (no wb)
    // and we want to stay there instead of snapping back to whichever
    // section happens to contain the last-active workblock.
    const sections = computeSections();
    if (activeSectionIndex >= sections.length) {
      activeSectionIndex = Math.max(0, sections.length - 1);
    }
    const currentSection = sections[activeSectionIndex] || [];
    const currentSectionWbs = currentSection.filter((b) => b.type === BLOCK.WORK);
    // Pin activeWorkBlock to the current section so typing always lands
    // in something the kid can see. If the section is worksheet-only,
    // activeWorkBlock = null disables typing — better than letting keys
    // edit a hidden workblock in another section.
    if (currentSectionWbs.length === 0) {
      activeWorkBlock = null;
    } else if (!currentSectionWbs.includes(activeWorkBlock)) {
      activeWorkBlock = currentSectionWbs[0];
    }
    const activeBlockIds = new Set(
      (sections[activeSectionIndex] || []).map((b) => b.id)
    );
    const showSectionPager = sections.length > 1;
    editorEl.classList.toggle('editor--single-section', !showSectionPager);
    const sectionBar = document.getElementById('section-bar');
    const sectionCount = document.getElementById('section-count');
    if (sectionBar) sectionBar.hidden = !showSectionPager;
    if (sectionCount) {
      sectionCount.textContent = `${activeSectionIndex + 1} / ${Math.max(1, sections.length)}`;
    }
    for (const block of page.blocks) {
      let el = null;
      if (block.type === BLOCK.WORKSHEET) {
        // focusedGridAnnot is read by buildGridAnnotationEl to paint
        // the active cell's cursor highlight. Pass it only when the
        // active grid annotation belongs to THIS worksheet block —
        // otherwise the cursor would render on a grid in another section.
        const gridFocus = (activeGridAnnot && activeGridAnnot.worksheetBlockId === block.id)
          ? {
              annotId: activeGridAnnot.annotId,
              r: activeGridAnnot.cursor.r,
              c: activeGridAnnot.cursor.c,
              slot: activeGridAnnot.cursor.slot || null
            }
          : null;
        el = await renderWorksheetBlock(block, {
          onDelete: (id) => removeBlock(id),
          annotateMode: annotateKind,
          onCreateAnnotation: createAnnotation,
          onAnnotationChanged: (_blockId) => queueSave(),
          // Push an undo snapshot when the kid enters manipulate mode
          // (long-press or "⋯" badge), so subsequent drag / resize /
          // A−/A+ changes can be undone with ↺. Without this, an
          // accidental drag had no recovery path.
          onAnnotationManipulateStart: (_blockId, _annotId) => pushUndo(),
          onDeleteAnnotation: deleteAnnotation,
          focusedGridAnnot: gridFocus,
          onGridAnnotCellTap: focusGridAnnotCell
        });
      } else if (block.type === BLOCK.WORK) {
        // Only the active work block carries a cursor — without this every
        // grid painted a cell--cursor at (cursor.r, cursor.c), so the kid
        // saw the blue highlight echoing across every work block on the page.
        // When a grid annotation is focused, the workblock cursor is
        // suppressed too so the kid sees the active cursor in exactly
        // one place at a time (the grid annot's cell).
        const isActive = block === activeWorkBlock;
        const showCursor = isActive && !activeGridAnnot;
        const { wrapper, grid } = renderWorkBlock(block, {
          cursor: showCursor ? cursor : null,
          onCellTap: (r, c) => {
            // Tapping a cell switches focus to that work block (if there
            // are several) and back to the math keypad.
            //
            // If a worksheet annotation currently has focus, blur it
            // here — work-block cells aren't focus targets (no tabindex),
            // so the tap alone wouldn't drop focus from the annotation,
            // and the keypad would keep routing to it instead of into
            // the cell the kid just tapped.
            const annotEl = getFocusedAnnotation();
            if (annotEl) annotEl.blur();
            // Drop any active grid-annot focus — the kid is back in
            // the main work area, so the keypad must stop routing into
            // the worksheet overlay's grid annotation.
            const hadGridAnnot = activeGridAnnot != null;
            activeGridAnnot = null;
            if (activeWorkBlock !== block) {
              clearActiveCursorHighlight();
              activeWorkBlock = block;
              activeGrid = grid;
              cursor.r = 0; cursor.c = MARGIN_COLS; cursor.slot = null;
              // Sync the pager so it always shows the section that
              // contains the kid's focus — without this, tapping a wb
              // in a different section (only possible in non-split
              // mode) would leave the pager pointing elsewhere.
              const newSections = computeSections();
              const idx = newSections.findIndex((s) => s.includes(block));
              if (idx >= 0) activeSectionIndex = idx;
            }
            if (keypadMode !== 'math') setKeypadMode('math');
            // If a grid annotation was previously focused, re-render so
            // its cell-cursor highlight clears.
            if (hadGridAnnot) renderBlocks();
            moveCursor(r, c);
          },
          onLabelEdit: handleExerciseLabelEdit,
          onMovePart: (part, drow, dcol) => movePartAndSave(block, part, drow, dcol),
          onDelete: canDeleteWork ? (id) => removeBlock(id) : undefined,
          onRowLabelTap: (r, overlay) => openRowLabelEditor(block, r, overlay),
          rowLabelEditingRow:
            activeRowLabel && activeRowLabel.blockId === block.id
              ? activeRowLabel.row
              : null
        });
        el = wrapper;
        if (isActive) {
          activeGrid = grid;
        }
      } else if (block.type === BLOCK.GRAPH) {
        el = renderGraphBlock(block, {
          // Snapshot before the first mutation of a gesture so ↺ can undo a
          // placed / dragged / deleted point, mirroring how grid annotations
          // push undo on manipulate-start.
          onEditStart: () => pushUndo(),
          onChange: () => queueSave(),
          onDelete: (id) => removeBlock(id)
        });
      }
      // Any other block type (e.g. legacy 'text' from the short-lived
      // textbox feature) renders nothing — text is now typed directly on
      // the grid via the Hebrew keypad.
      if (el) {
        attachBlockChrome(el, block);
        applyBlockOffset(el, block);
        // Blocks outside the active section are hidden in split mode via
        // CSS (.editor--split .block--inactive-section). In stacked mode
        // the class has no effect — every block stays visible top-to-bottom.
        if (!activeBlockIds.has(block.id)) {
          el.classList.add('block--inactive-section');
        }
        pageHost.appendChild(el);
      }
    }
    // The previously active work block may have been deleted or resized;
    // clamp the cursor so it always lands on a real cell of whichever
    // block is now active.
    if (activeWorkBlock) {
      cursor.r = clamp(cursor.r, 0, activeWorkBlock.rows - 1);
      cursor.c = clamp(cursor.c, MARGIN_COLS, activeWorkBlock.cols - 1);
      const anchor = findOccupyingAnchor(activeWorkBlock, cursor.r, cursor.c);
      if (anchor) { cursor.r = anchor.r; cursor.c = anchor.c; }
      if (cursor.slot && !activeWorkBlock.cells[`${cursor.r},${cursor.c}`]) {
        cursor.slot = null;
      }
    } else {
      cursor.slot = null;
    }
    // Allow layout to settle, then resize the canvas to match content.
    requestAnimationFrame(() => resizeAndReplay());
  }

  // Drag handle on every block + resize handle on work blocks. Called from
  // renderBlocks AND from rerenderActiveGrid (the latter rebuilds the
  // wrapper after a fraction widens, and would otherwise drop the handles).
  function attachBlockChrome(el, block) {
    attachBlockDragHandle(el, block);
    if (block.type === BLOCK.WORK) {
      attachWorkBlockResize(el, block);
      attachWorkBlockColsChip(el, block);
    }
  }

  // Group the page's blocks into sections, where each section starts with
  // a worksheet and contains every following non-worksheet block up to the
  // next worksheet. Blocks before the first worksheet (or if there's no
  // worksheet at all) form a leading "no-worksheet" section so the page
  // always has at least one renderable section.
  function computeSections() {
    const sections = [];
    let current = null;
    for (const b of page.blocks) {
      if (b.type === BLOCK.WORKSHEET) {
        if (current) sections.push(current);
        current = [b];
      } else {
        if (!current) current = [];
        current.push(b);
      }
    }
    if (current) sections.push(current);
    return sections;
  }

  // Pager click handler: jump to a different section. Wraps around so the
  // kid can flip in either direction without hitting an "end" state. Also
  // re-points activeWorkBlock at the first workblock in the new section so
  // typing immediately lands somewhere sensible.
  function setActiveSection(idx) {
    const sections = computeSections();
    if (sections.length === 0) return;
    const next = ((idx % sections.length) + sections.length) % sections.length;
    activeSectionIndex = next;
    const section = sections[next];
    const wb = section.find((b) => b.type === BLOCK.WORK);
    // Re-point at this section's workblock (or null if it's a
    // worksheet-only section — clearing prevents the renderBlocks
    // sync from snapping back to the old section's workblock).
    activeWorkBlock = wb || null;
    if (wb) {
      cursor.r = 0;
      cursor.c = MARGIN_COLS;
      cursor.slot = null;
    }
    renderBlocks();
  }

  // Small "{used}/{cols}" chip on the top-end of a work block. Shows how much
  // of the cursor row is filled, and turns amber when the row is at capacity
  // so the kid sees space pressure before they hit a refusal.
  function attachWorkBlockColsChip(wrapper, block) {
    const chip = document.createElement('span');
    chip.className = 'workblock__cols';
    chip.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(chip);
    refreshColsChip(wrapper, block);
  }

  function refreshColsChip(wrapper, block) {
    if (!wrapper) return;
    const chip = wrapper.querySelector('.workblock__cols');
    if (!chip) return;
    const row = (activeWorkBlock === block) ? cursor.r : 0;
    let used = 0;
    for (const [key, cell] of Object.entries(block.cells)) {
      const [rr, cc] = key.split(',').map(Number);
      if (rr !== row) continue;
      const end = cc + compositeWidth(cell);
      if (end > used) used = end;
    }
    chip.textContent = `↔ ${used}/${block.cols}`;
    // Only surface the chip when the kid is close to or at capacity — the
    // CSS hides it entirely otherwise so the workblock stays uncluttered.
    chip.classList.toggle('workblock__cols--full', used >= Math.ceil(block.cols * 0.8));
  }

  function refreshActiveColsChip() {
    if (!activeGrid || !activeWorkBlock) return;
    refreshColsChip(activeGrid.parentElement, activeWorkBlock);
  }

  // Apply a block's persisted horizontal offset (set by drag-to-reposition).
  // Vertical position is still controlled by the document flow / reorder.
  function applyBlockOffset(el, block) {
    const x = Number(block.xOffset) || 0;
    el.style.transform = x ? `translateX(${x}px)` : '';
    el.dataset.xOffset = String(x);
  }

  // Add a small drag handle button to the top-start of the block. Pointer-
  // event-driven reorder: while dragging, we lift the block visually and
  // show a thin blue indicator at the prospective drop position. On release
  // we swap into page.blocks at that index. Disabled while pen mode is on
  // so the canvas's pointer-events: auto doesn't fight the handle.
  function attachBlockDragHandle(el, block) {
    el.classList.add('block');
    const handle = document.createElement('div');
    handle.className = 'block__handle';
    handle.title = 'סידור מחדש';
    handle.setAttribute('role', 'group');
    handle.setAttribute('aria-label', 'סדר את הבלוק');

    // Tap-only path: up/down arrows shift the block one slot at a time
    // without requiring a sustained drag. Accessibility audit flagged
    // drag-only reorder as a major motor-impairment issue. Drag still
    // works for kids who can manage it (it's wired on the dots).
    const idx = () => page.blocks.indexOf(block);
    const canMoveUp = () => idx() > 0;
    const canMoveDown = () => idx() >= 0 && idx() < page.blocks.length - 1;

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'block__handle-arrow';
    upBtn.textContent = '▲';
    upBtn.title = 'הזיזי למעלה';
    upBtn.setAttribute('aria-label', 'הזיזי למעלה');

    const dots = document.createElement('span');
    dots.className = 'block__handle-dots';
    dots.textContent = '⋮⋮';
    dots.style.cursor = 'grab';
    dots.style.padding = '0 4px';

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'block__handle-arrow';
    downBtn.textContent = '▼';
    downBtn.title = 'הזיזי למטה';
    downBtn.setAttribute('aria-label', 'הזיזי למטה');

    const refreshDisabled = () => {
      upBtn.disabled = !canMoveUp();
      downBtn.disabled = !canMoveDown();
    };
    refreshDisabled();

    const move = async (delta) => {
      const i = idx();
      const j = i + delta;
      if (i < 0 || j < 0 || j >= page.blocks.length) return;
      pushUndo();
      const [moved] = page.blocks.splice(i, 1);
      page.blocks.splice(j, 0, moved);
      await savePage(page);
      await renderBlocks();
    };
    upBtn.addEventListener('click', (e) => { e.stopPropagation(); move(-1); });
    downBtn.addEventListener('click', (e) => { e.stopPropagation(); move(+1); });
    // mousedown preventDefault on the buttons so they don't steal focus
    // from the active work-block cell.
    upBtn.addEventListener('mousedown', (e) => e.preventDefault());
    downBtn.addEventListener('mousedown', (e) => e.preventDefault());

    // Drag-to-reorder remains, anchored on the central ⋮⋮ dots only —
    // not the whole handle area — so the up/down arrows can be tapped
    // without arming a drag.
    dots.addEventListener('mousedown', (e) => e.preventDefault());
    dots.addEventListener('pointerdown', (e) => {
      if (pencilEnabled) return;
      // Pass `dots` (the actual event target) as the captureEl so
      // setPointerCapture works correctly — the parent handle div is a
      // container, not the element under the kid's finger.
      startBlockDrag(e, el, block, dots);
    });

    handle.appendChild(upBtn);
    handle.appendChild(dots);
    handle.appendChild(downBtn);
    el.appendChild(handle);
  }

  // Resize handle on the bottom-right of a work block. Drag it to add/remove
  // rows and columns — the kid uses this to shrink the work area when their
  // solution is short, so the next worksheet image isn't pushed way down by
  // a long blank grid. Snap to whole cells; persist on pointerup.
  function attachWorkBlockResize(wrapper, block) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'workblock__resize';
    handle.title = 'גרור כדי לשנות גודל';
    handle.setAttribute('aria-label', 'שנה גודל');
    handle.textContent = '⤡';
    handle.addEventListener('mousedown', (e) => e.preventDefault());

    let state = null;

    handle.addEventListener('pointerdown', (e) => {
      if (pencilEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const grid = wrapper.querySelector('.grid');
      const cellSize =
        parseFloat(getComputedStyle(grid).getPropertyValue('--cell-size')) || 38;
      // Capture pre-resize state so the kid can undo the gesture. Resize
      // mutates rows/cols incrementally during pointermove, so the snapshot
      // has to be taken BEFORE the drag starts. If the gesture turns out to
      // be a no-op, dedup-on-undo handles the redundant entry.
      pushUndo();
      state = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origRows: block.rows,
        origCols: block.cols,
        cellSize,
        changed: false
      };
      wrapper.classList.add('workblock--resizing');
    });

    handle.addEventListener('pointermove', (e) => {
      if (!state || e.pointerId !== state.pointerId) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      const newCols = clamp(
        state.origCols + Math.round(dx / state.cellSize),
        4,
        40
      );
      const newRows = clamp(
        state.origRows + Math.round(dy / state.cellSize),
        2,
        40
      );
      if (newCols !== block.cols || newRows !== block.rows) {
        block.cols = newCols;
        block.rows = newRows;
        state.changed = true;
        // Live preview only for the active grid (cheap, in-place rerender).
        // For other work blocks we wait for pointerup to avoid full
        // page-rerender storms during the drag.
        if (activeWorkBlock === block) rerenderActiveGrid();
      }
    });

    const onUp = async (e) => {
      if (!state || e.pointerId !== state.pointerId) return;
      const wasChanged = state.changed;
      state = null;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      wrapper.classList.remove('workblock--resizing');
      if (!wasChanged) return;

      // Drop any cells that no longer fit, including composites whose
      // span would extend past the new column count. Strokes anchored to
      // this block stay — their points are block-relative, so the user can
      // still see what was drawn even when the grid shrinks below them.
      const newCells = {};
      for (const [key, cell] of Object.entries(block.cells)) {
        const [r, c] = key.split(',').map(Number);
        const w = compositeWidth(cell);
        if (r < block.rows && c + w <= block.cols) newCells[key] = cell;
      }
      block.cells = newCells;
      // Clamp the cursor inside the new bounds.
      cursor.r = clamp(cursor.r, 0, block.rows - 1);
      cursor.c = clamp(cursor.c, MARGIN_COLS, block.cols - 1);
      if (cursor.slot && !block.cells[`${cursor.r},${cursor.c}`]) {
        cursor.slot = null;
      }
      await savePage(page);
      await renderBlocks();
    };
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);

    wrapper.appendChild(handle);
  }

  let dragState = null;
  function startBlockDrag(downEvent, el, block, handle) {
    downEvent.preventDefault();
    handle.setPointerCapture(downEvent.pointerId);

    // Capture state BEFORE the reorder gesture commits so undo can revert
    // the move. If the kid releases without moving anything, dedup keeps
    // the stack clean.
    pushUndo();

    const blocksContainer = pageHost;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const baseXOffset = Number(block.xOffset) || 0;

    dragState = {
      pointerId: downEvent.pointerId,
      block,
      el,
      handle,
      startX,
      startY,
      baseXOffset,
      dx: 0,
      dy: 0,
      moved: false,
      indicator: null,
      targetIndex: null
    };

    el.classList.add('block--dragging');

    const onMove = (e) => {
      if (e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragState.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      dragState.moved = true;
      dragState.dx = dx;
      dragState.dy = dy;
      el.style.transform = `translate(${baseXOffset + dx}px, ${dy}px)`;

      // Compute where the block would land vertically — compare the
      // pointer's clientY against the midpoint of each sibling block in the
      // CURRENT order (excluding the one being dragged) and find the slot.
      const siblings = [...blocksContainer.children].filter(
        (n) => n !== el && n.dataset.blockId
      );
      let targetIndex = siblings.length;
      for (let i = 0; i < siblings.length; i += 1) {
        const r = siblings[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          targetIndex = i;
          break;
        }
      }
      showDropIndicator(siblings, targetIndex);
      dragState.targetIndex = targetIndex;
    };

    const onUp = async (e) => {
      if (e.pointerId !== dragState.pointerId) return;
      const ds = dragState;
      dragState = null;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.classList.remove('block--dragging');
      removeDropIndicator();

      if (!ds.moved) {
        // No real movement — restore the original transform so the
        // persisted xOffset stays applied.
        applyBlockOffset(el, ds.block);
        return;
      }

      // Persist the horizontal offset. Clamp so the kid can't shove a
      // block far off-screen and lose track of it. The page content is
      // centered, so we allow ±half the page width as a rough bound.
      const pageRect = pageContent.getBoundingClientRect();
      const maxX = Math.max(0, pageRect.width / 2);
      const newXOffset = clamp(ds.baseXOffset + ds.dx, -maxX, maxX);
      const xChanged = newXOffset !== (Number(ds.block.xOffset) || 0);
      if (xChanged) ds.block.xOffset = newXOffset;

      // Reorder vertically.
      let orderChanged = false;
      if (ds.targetIndex != null) {
        const others = page.blocks.filter((b) => b.id !== ds.block.id);
        others.splice(ds.targetIndex, 0, ds.block);
        orderChanged = !others.every((b, i) => b === page.blocks[i]);
        if (orderChanged) page.blocks = others;
      }

      if (xChanged || orderChanged) {
        await savePage(page);
        await renderBlocks();
      } else {
        // Nothing to commit — just snap the visual back to the persisted
        // offset (clears the in-drag transform).
        applyBlockOffset(el, ds.block);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function showDropIndicator(siblings, index) {
    removeDropIndicator();
    const indicator = document.createElement('div');
    indicator.className = 'block-drop-indicator';
    if (index >= siblings.length) {
      pageHost.appendChild(indicator);
    } else {
      pageHost.insertBefore(indicator, siblings[index]);
    }
    if (dragState) dragState.indicator = indicator;
  }

  function removeDropIndicator() {
    pageHost.querySelectorAll('.block-drop-indicator').forEach((n) => n.remove());
  }

  // ---------- worksheet annotations ----------

  // Drop a new annotation at (xFrac, yFrac), then re-render so the new
  // element exists in the DOM and the kid can focus it to start typing.
  // Position is stored as 0..1 fractions of the rendered overlay, so the
  // annotation stays anchored at any display size or zoom.
  //
  // kind selects the annotation flavor:
  //   'grid' — a small grid-cell calculation pad (default for new taps
  //            when the kid has the 🔢 toolbar button enabled).
  //   'text' — a free-form contenteditable for written notes.
  async function createAnnotation(blockId, xFrac, yFrac, kind = 'grid') {
    const block = page.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== BLOCK.WORKSHEET) return;
    // One-shot placement: a single tap drops one box and immediately leaves
    // armed mode, so the next tap on the worksheet (or an accidental brush)
    // doesn't spawn another. The re-render triggered below sheds the
    // crosshair/annotate class once annotateKind is cleared.
    disarmAnnotate();
    pushUndo();
    if (!Array.isArray(block.annotations)) block.annotations = [];
    let annot;
    if (kind === 'grid') {
      // Grid annotation default size is wider than a text annotation
      // (~30% of image width) so the kid sees a useful 3×8 cell layout
      // without immediately having to resize.
      annot = newGridAnnotation({ x: xFrac, y: yFrac, w: 0.30 });
    } else if (kind === 'graph') {
      // A coordinate plane needs more room than a calculation grid; ~40%
      // of the image width gives a usable −10..10 plane out of the box.
      annot = newGraphAnnotation({ x: xFrac, y: yFrac, w: 0.40 });
      activeGridAnnot = null;
    } else {
      // Default width is generous (~22% of image width). The annotation
      // shrinks naturally as text fills it — there's no max width — but
      // starting wide lets short answers sit on one line.
      annot = newAnnotation({ x: xFrac, y: yFrac, w: 0.22 });
      // Drop any previously-focused grid annotation — focusing the new
      // text contenteditable is the kid's signal that they're switching
      // input target, but blur on a text annot doesn't automatically
      // clear activeGridAnnot, which would leak the routing.
      activeGridAnnot = null;
    }
    block.annotations.push(annot);
    queueSave();
    if (kind === 'grid') {
      // Immediately focus the new grid's top-left cell so the kid can
      // start typing without an extra tap. focusGridAnnotCell handles
      // the re-render + cursor placement.
      focusGridAnnotCell(blockId, annot.id, 0, 0);
    } else if (kind === 'graph') {
      // A graph isn't a typing target — just render it in place.
      await renderBlocks();
    } else {
      await renderBlocks();
      // Focus the freshly-placed annotation so the kid can immediately
      // type. Defer to next frame so the contenteditable is wired up
      // by the render pass before we move the caret into it.
      requestAnimationFrame(() => {
        const el = pageHost.querySelector(`[data-annot-id="${annot.id}"]`);
        if (el) el.focus();
      });
    }
  }

  // Tap-into-cell handler shared by every grid annotation on the page.
  // Sets the keypad focus to this cell so subsequent presses land there.
  // Clears the active workblock cursor highlight on the way in — the
  // two focus targets are mutually exclusive.
  function focusGridAnnotCell(worksheetBlockId, annotId, r, c) {
    const block = page.blocks.find((b) => b.id === worksheetBlockId);
    if (!block) return;
    const annot = (block.annotations || []).find((a) => a.id === annotId);
    if (!annot || !isGridAnnotation(annot)) return;
    // Drop work-block cursor + any focused text annotation. The keypad
    // will route into the grid annotation from here on.
    const textAnnotEl = getFocusedAnnotation();
    if (textAnnotEl) textAnnotEl.blur();
    clearActiveCursorHighlight();
    // Keep the workblock reference around for re-activation when the
    // kid taps back into a workblock cell, but clear the in-grid
    // cursor so its highlight doesn't render alongside the grid-annot
    // cursor.
    activeGridAnnot = {
      worksheetBlockId,
      annotId,
      cursor: {
        r: Math.max(0, Math.min(annot.rows - 1, r)),
        c: Math.max(0, Math.min(annot.cols - 1, c))
      }
    };
    if (keypadMode !== 'math') setKeypadMode('math');
    renderBlocks();
  }

  // Exercise-label edit handler — persist the kid's typed override.
  // Called on every `input` event from the contenteditable label chip.
  // Trim trailing whitespace so a stray newline (from accidental ⏎
  // routing) doesn't get baked into the stored label.
  function handleExerciseLabelEdit(blockId, raw) {
    const block = page.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== BLOCK.WORK) return;
    const cleaned = (raw || '').replace(/\s+/g, ' ').trim();
    if (block.label === cleaned) return;
    pushUndo();
    block.label = cleaned;
    queueSave();
  }

  async function deleteAnnotation(blockId, annotId) {
    const block = page.blocks.find((b) => b.id === blockId);
    if (!block || !Array.isArray(block.annotations)) return;
    const idx = block.annotations.findIndex((a) => a.id === annotId);
    if (idx < 0) return;
    pushUndo();
    block.annotations.splice(idx, 1);
    queueSave();
    await renderBlocks();
  }

  // ---------- worksheet add / remove ----------

  async function addWorksheet({ capture }) {
    // uploadWorksheet returns an array: one block for an image, or N
    // blocks for an N-page PDF (each page rendered to its own PNG).
    const newWs = await uploadWorksheet({ capture });
    if (!newWs || newWs.length === 0) return;
    pushUndo();
    const hasExistingWorksheet = page.blocks.some(
      (b) => b.type === BLOCK.WORKSHEET
    );

    // Insert each uploaded page. The first new worksheet follows the
    // existing pairing rules (slot in front of the implicit first work
    // block, or append a new paired section); subsequent pages always
    // append as their own paired section so a PDF expands into one
    // worksheet+workblock pair per page.
    const firstNewWs = newWs[0];
    const restOfNewWs = newWs.slice(1);

    // Helper used by every paired-section push below — derive the next
    // exercise label from whatever work block is currently last on the
    // page. Each push appends to page.blocks, so the "previous" block
    // is naturally the last one in document order at the moment we
    // call this.
    const nextLabelForAppend = () => {
      const wbs = page.blocks.filter((b) => b.type === BLOCK.WORK);
      const prev = wbs.length ? wbs[wbs.length - 1].label : '';
      return nextExerciseLabel(prev) || String(wbs.length + 1);
    };

    if (!hasExistingWorksheet) {
      // First worksheet on the page — insert it ahead of the implicit
      // first work block so the kid's existing work area is paired with
      // the new worksheet image.
      const workIndex = page.blocks.findIndex((b) => b.type === BLOCK.WORK);
      if (workIndex < 0) page.blocks.push(firstNewWs);
      else page.blocks.splice(workIndex, 0, firstNewWs);
    } else {
      // Subsequent uploads each become their own paired section: append
      // the new worksheet AND a fresh work block right after it. Without
      // this the kid uploads a second page but has no place to solve it.
      page.blocks.push(firstNewWs);
      page.blocks.push(newWorkBlock({ label: nextLabelForAppend() }));
    }
    for (const ws of restOfNewWs) {
      page.blocks.push(ws);
      page.blocks.push(newWorkBlock({ label: nextLabelForAppend() }));
    }

    // Activate the FIRST new section so split view jumps to it immediately
    // — for a multi-page PDF, the kid lands on page 1 and uses the pager
    // to walk forward.
    const sections = computeSections();
    activeSectionIndex = sections.findIndex((s) => s.includes(firstNewWs));
    if (activeSectionIndex < 0) activeSectionIndex = 0;
    const newWb = (sections[activeSectionIndex] || []).find(
      (b) => b.type === BLOCK.WORK
    );
    if (newWb) {
      activeWorkBlock = newWb;
      cursor.r = 0;
      cursor.c = MARGIN_COLS;
      cursor.slot = null;
    }
    await savePage(page);
    await renderBlocks();
  }

  async function removeBlock(blockId) {
    const block = page.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const isWork = block.type === BLOCK.WORK;
    const isGraph = block.type === BLOCK.GRAPH;
    const ok = await confirmDialog({
      title: isWork ? 'הסרת אזור פתרון' : isGraph ? 'הסרת גרף' : 'הסרת דף',
      body: isWork ? 'להסיר את אזור הפתרון הזה?' : isGraph ? 'להסיר את הגרף הזה?' : 'להסיר את הדף הזה?',
      confirmLabel: 'הסרה',
      cancelLabel: 'ביטול',
      destructive: true
    });
    if (!ok) return;
    pushUndo();

    // Delete any strokes that belong to this block. Strokes anchored to the
    // block by id (the modern path) are removed directly. Legacy unanchored
    // strokes are matched by spatial overlap with the block's vertical
    // extent — same fallback as before, kept so old notebooks still
    // self-clean when the user removes a block.
    {
      const figure = pageHost.querySelector(`[data-block-id="${blockId}"]`);
      let yTop = -Infinity;
      let yBottom = -Infinity;
      if (figure && pageContent) {
        const figRect = figure.getBoundingClientRect();
        const contentRect = pageContent.getBoundingClientRect();
        yTop = figRect.top - contentRect.top;
        yBottom = figRect.bottom - contentRect.top;
      }
      // Wait for any in-flight saves so we don't race with stroke writes.
      await Promise.allSettled([...pendingStrokeSaves]);
      const toDelete = strokes.filter((s) => {
        if (s.blockId === blockId) return true;
        if (!s.blockId && yTop !== -Infinity) {
          return (s.points || []).some((p) => p.y >= yTop && p.y <= yBottom);
        }
        return false;
      });
      for (const stroke of toDelete) {
        try { await deleteStrokeById(stroke.id); } catch (_) {}
      }
      const deletedIds = new Set(toDelete.map((s) => s.id));
      for (let i = strokes.length - 1; i >= 0; i -= 1) {
        if (deletedIds.has(strokes[i].id)) strokes.splice(i, 1);
      }
    }

    // If the deleted block belongs to the active section, fall forward to
    // the next section (or back to the previous one if the last section
    // was removed) so the pager doesn't snap to page 1.
    const sectionsBefore = computeSections();
    const oldSectionIdx = sectionsBefore.findIndex((s) =>
      s.some((b) => b.id === blockId)
    );
    const removedIdx = page.blocks.findIndex((b) => b.id === blockId);
    page.blocks = page.blocks.filter((b) => b.id !== blockId);
    // If we removed a worksheet AND the immediately-following block is an
    // EMPTY work block (typical for the paired-section layout used by
    // multi-page PDF imports), drop the orphan too. Without this, the
    // empty workblock was getting absorbed into the previous section and
    // confused the pager. Only auto-remove when at least one workblock
    // still remains on the page so the kid is never left without a
    // typing area. (Worksheet QA.)
    if (block.type === BLOCK.WORKSHEET && removedIdx >= 0 && removedIdx < page.blocks.length) {
      const next = page.blocks[removedIdx];
      if (next && next.type === BLOCK.WORK &&
          (!next.cells || Object.keys(next.cells).length === 0) &&
          page.blocks.some((b, i) => b.type === BLOCK.WORK && i !== removedIdx)) {
        page.blocks.splice(removedIdx, 1);
      }
    }
    const sectionsAfter = computeSections();
    if (oldSectionIdx === activeSectionIndex) {
      if (activeSectionIndex >= sectionsAfter.length) {
        activeSectionIndex = Math.max(0, sectionsAfter.length - 1);
      }
    } else if (oldSectionIdx >= 0 && oldSectionIdx < activeSectionIndex) {
      // A section before the active one was removed — shift the index
      // down so we stay on the same logical page.
      activeSectionIndex = Math.max(0, activeSectionIndex - 1);
    }
    if (block.type === BLOCK.WORKSHEET && block.blobId) {
      revokeBlobUrl(block.blobId);
      await deleteBlob(block.blobId);
    }
    await savePage(page);
    await renderBlocks();
  }

  async function addWorkBlock() {
    pushUndo();
    // Auto-increment the label from the LAST work block on the page so
    // the kid's "+ תרגיל חדש" always lands on the next sensible number
    // or Hebrew letter. We use page-order (not section-order) because
    // labels reflect the worksheet's numbering scheme, not where on
    // the page the kid happens to be — and the kid can always tap the
    // chip and override if the worksheet skips ahead.
    const workBlocks = page.blocks.filter((b) => b.type === BLOCK.WORK);
    const prevLabel = workBlocks.length ? workBlocks[workBlocks.length - 1].label : '';
    // If nextExerciseLabel can't make sense of the previous label (e.g.
    // the kid typed "תרגיל א" or left it blank), fall back to the
    // 1-based ordinal so the chip is never empty by surprise.
    const computed = nextExerciseLabel(prevLabel);
    const label = computed || String(workBlocks.length + 1);
    const newBlock = newWorkBlock({ label });
    // Insert the new exercise block right after the last block of the
    // currently active section so the kid sees the new exercise next
    // to where she was working. Falling back to page-append covers the
    // edge case where computeSections is empty (no blocks on the page
    // at all — shouldn't happen, but defensive).
    const sections = computeSections();
    const activeSection = sections[activeSectionIndex];
    if (activeSection && activeSection.length > 0) {
      const lastInSection = activeSection[activeSection.length - 1];
      const insertAt = page.blocks.indexOf(lastInSection) + 1;
      page.blocks.splice(insertAt, 0, newBlock);
    } else {
      page.blocks.push(newBlock);
    }
    activeWorkBlock = newBlock;
    activeGridAnnot = null;
    cursor.r = 0;
    cursor.c = MARGIN_COLS;
    cursor.slot = null;
    await savePage(page);
    await renderBlocks();
  }

  // Add a coordinate-plane graph block. Like addWorkBlock, it lands right
  // after the active section's last block so a graph drops in below the
  // worksheet (or the work area) the kid is currently looking at. The
  // worksheet image is a separate stored block and is never touched.
  async function addGraphBlock() {
    pushUndo();
    const newBlock = newGraphBlock();
    const sections = computeSections();
    const activeSection = sections[activeSectionIndex];
    if (activeSection && activeSection.length > 0) {
      const lastInSection = activeSection[activeSection.length - 1];
      const insertAt = page.blocks.indexOf(lastInSection) + 1;
      page.blocks.splice(insertAt, 0, newBlock);
    } else {
      page.blocks.push(newBlock);
    }
    // A graph isn't a typing target; drop grid-annot focus so the keypad
    // doesn't keep routing into a worksheet overlay behind the new graph.
    activeGridAnnot = null;
    await savePage(page);
    await renderBlocks();
  }

  // Insert a blank row above the cursor's current row in the active work
  // block. All cells at row >= cursor.r shift down by one and the row count
  // grows by one. Refuses if the grid is already at the resize-handle max
  // (40 rows).
  async function insertRowAtCursor() {
    if (!activeWorkBlock) return;
    if (activeWorkBlock.rows >= 40) {
      toast('הגעת למספר השורות המרבי.', { kind: 'warn', duration: 2400 });
      return;
    }
    pushUndo();
    const r = cursor.r;
    const newCells = {};
    for (const [key, cell] of Object.entries(activeWorkBlock.cells)) {
      const [rr, cc] = key.split(',').map(Number);
      newCells[`${rr >= r ? rr + 1 : rr},${cc}`] = cell;
    }
    activeWorkBlock.cells = newCells;
    activeWorkBlock.rows += 1;
    await savePage(page);
    await renderBlocks();
  }

  // Delete the cursor's current row in the active work block. Cells in that
  // row are dropped; rows below shift up. Refuses if it would take the
  // block below 2 rows (matching the resize handle's lower bound).
  async function deleteRowAtCursor() {
    if (!activeWorkBlock) return;
    if (activeWorkBlock.rows <= 2) {
      toast('לא ניתן לרדת מתחת לשתי שורות.', { kind: 'warn', duration: 2400 });
      return;
    }
    pushUndo();
    const r = cursor.r;
    const newCells = {};
    for (const [key, cell] of Object.entries(activeWorkBlock.cells)) {
      const [rr, cc] = key.split(',').map(Number);
      if (rr === r) continue;
      newCells[`${rr > r ? rr - 1 : rr},${cc}`] = cell;
    }
    activeWorkBlock.cells = newCells;
    activeWorkBlock.rows -= 1;
    cursor.r = clamp(cursor.r, 0, activeWorkBlock.rows - 1);
    cursor.slot = null;
    await savePage(page);
    await renderBlocks();
  }

  // Insert a blank column to the LEFT of the cursor's current column. Cells
  // at col >= cursor.c shift right by one. The grid is LTR (math), so "left
  // of the cursor" is the visually-leading edge.
  async function insertColAtCursor() {
    if (!activeWorkBlock) return;
    if (activeWorkBlock.cols >= 40) {
      toast('הגעת למספר העמודות המרבי.', { kind: 'warn', duration: 2400 });
      return;
    }
    pushUndo();
    const c = cursor.c;
    const newCells = {};
    for (const [key, cell] of Object.entries(activeWorkBlock.cells)) {
      const [rr, cc] = key.split(',').map(Number);
      newCells[`${rr},${cc >= c ? cc + 1 : cc}`] = cell;
    }
    activeWorkBlock.cells = newCells;
    activeWorkBlock.cols += 1;
    await savePage(page);
    await renderBlocks();
  }

  // Delete the cursor's current column. Cells in that column are dropped;
  // columns to the right shift left. Composites whose anchor sat in the
  // deleted column lose their anchor (their data is dropped) — the kid is
  // expected to delete a column they actually want emptied.
  async function deleteColAtCursor() {
    if (!activeWorkBlock) return;
    if (activeWorkBlock.cols <= 4) {
      toast('לא ניתן לרדת מתחת לארבע עמודות.', { kind: 'warn', duration: 2400 });
      return;
    }
    pushUndo();
    const c = cursor.c;
    const newCells = {};
    for (const [key, cell] of Object.entries(activeWorkBlock.cells)) {
      const [rr, cc] = key.split(',').map(Number);
      if (cc === c) continue;
      newCells[`${rr},${cc > c ? cc - 1 : cc}`] = cell;
    }
    activeWorkBlock.cells = newCells;
    activeWorkBlock.cols -= 1;
    cursor.c = clamp(cursor.c, MARGIN_COLS, activeWorkBlock.cols - 1);
    cursor.slot = null;
    await savePage(page);
    await renderBlocks();
  }

  // Long-press part drag drop target — relocate every anchor in the
  // dragged contiguous run by (drow, dcol). The grid validates the move
  // before calling here, so we trust the offsets are legal. Active cursor
  // follows if it was inside the part so the kid keeps editing where
  // they were.
  async function movePartAndSave(block, part, drow, dcol) {
    if (drow === 0 && dcol === 0) return;
    pushUndo();
    const moves = [];
    for (let c = part.startCol; c <= part.endCol; c += 1) {
      const cell = block.cells[`${part.row},${c}`];
      if (cell) moves.push({ oldR: part.row, oldC: c, cell });
    }
    for (const m of moves) {
      delete block.cells[`${m.oldR},${m.oldC}`];
    }
    for (const m of moves) {
      block.cells[`${m.oldR + drow},${m.oldC + dcol}`] = m.cell;
    }
    if (
      activeWorkBlock === block &&
      cursor.r === part.row &&
      cursor.c >= part.startCol &&
      cursor.c <= part.endCol
    ) {
      cursor.r += drow;
      cursor.c += dcol;
    }
    await savePage(page);
    await renderBlocks();
  }

  // Move a block within the page.blocks array, then save and rerender.
  async function reorderBlock(blockId, newIndex) {
    const fromIndex = page.blocks.findIndex((b) => b.id === blockId);
    if (fromIndex < 0) return;
    const clamped = Math.max(0, Math.min(page.blocks.length - 1, newIndex));
    if (fromIndex === clamped) return;
    const [block] = page.blocks.splice(fromIndex, 1);
    page.blocks.splice(clamped, 0, block);
    await savePage(page);
    await renderBlocks();
  }

  // ---------- pencil drawing ----------

  // Translate a canvas-relative point into a block-relative one by
  // subtracting the block's top-left offset. Pressure (p) and timestamp (t)
  // pass through unchanged.
  function relativizePoint(point, offset) {
    return {
      ...point,
      x: point.x - (offset?.x || 0),
      y: point.y - (offset?.y || 0)
    };
  }

  // Find which rendered block contains a given canvas-relative point.
  // Returns { id, offset } or null when the point falls in a gap (above the
  // first block, between blocks, or below the last). Such strokes are saved
  // as page-anchored.
  function findBlockAtPoint(point) {
    if (!pageHost || !pageContent) return null;
    const contentRect = pageContent.getBoundingClientRect();
    for (const el of pageHost.children) {
      if (!el.dataset || !el.dataset.blockId) continue;
      const rect = el.getBoundingClientRect();
      const top = rect.top - contentRect.top;
      const bottom = rect.bottom - contentRect.top;
      if (point.y >= top && point.y <= bottom) {
        return {
          id: el.dataset.blockId,
          offset: { x: rect.left - contentRect.left, y: top }
        };
      }
    }
    return null;
  }

  // Read the current top-left of a block within canvas coords. Returns null
  // when the block is no longer rendered (caller decides what to do —
  // replay treats null as "skip orphan stroke").
  function getBlockOffset(blockId) {
    if (!blockId) return null;
    const el = pageHost && pageHost.querySelector(`[data-block-id="${blockId}"]`);
    if (!el || !pageContent) return null;
    const rect = el.getBoundingClientRect();
    // Hidden blocks (e.g. inactive worksheets in split-view paging) report
    // a zero-sized rect at the document origin. Treat them as not-rendered
    // so their strokes don't pile up at the page's top-left corner — they
    // reappear automatically when the kid pages back to that worksheet.
    if (rect.width === 0 && rect.height === 0) return null;
    const contentRect = pageContent.getBoundingClientRect();
    return { x: rect.left - contentRect.left, y: rect.top - contentRect.top };
  }

  // Used by replayStrokes — translates a stored stroke into its current
  // canvas position. Legacy unanchored strokes return null (render in place);
  // strokes whose block has been removed return false (skip rendering).
  function offsetForStroke(stroke) {
    if (!stroke.blockId) return null;
    const off = getBlockOffset(stroke.blockId);
    return off || false;
  }

  function setupPencilSurface() {
    detachPencilIfAny();
    detachPencil = attachPencilSurface(canvas, {
      isEnabled: () => pencilEnabled,
      // Drawing is gated entirely by pen-mode toggle. When pen mode is OFF
      // the canvas has pointer-events: none and finger taps fall through
      // to the grid for typing. When pen mode is ON, ANY pointer (Apple
      // Pencil, finger, or mouse on desktop) draws — needed because not
      // every kid has a Pencil.
      allowFinger: true,
      getColor: () => penColor,
      // Marker strokes are wide; pen strokes are thin.
      getWidth: () => (markerMode ? MARKER_WIDTH : penWidth),
      getEraserMode: () => eraserMode,
      getHighlighter: () => markerMode,
      onStrokeStart: ({ color, width, eraser, highlighter, point }) => {
        const id = `stroke_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        // Anchor the stroke to whichever block contains its first point.
        // Points are then stored block-relative so the stroke moves with
        // the block when it's reordered. If the start falls in the gap
        // between blocks, the stroke is page-anchored (blockId = null).
        const found = findBlockAtPoint(point);
        const blockId = found ? found.id : null;
        const blockOffset = found ? found.offset : { x: 0, y: 0 };
        liveStrokeOffsets.set(id, blockOffset);
        const relPoint = relativizePoint(point, blockOffset);
        const stroke = {
          id,
          pageId: page.id,
          blockId,
          color,
          width,
          eraser,
          highlighter,
          points: [relPoint],
          createdAt: Date.now()
        };
        liveStrokes.set(id, stroke);
        liveDrawnPointCount.set(id, 0);
        strokes.push(stroke);
        // Render the initial dot translated by the cached block offset.
        const dpr = window.devicePixelRatio || 1;
        renderStroke(ctx, stroke, dpr, blockOffset);
        liveDrawnPointCount.set(id, 1);
        return id;
      },
      onStrokePoint: (id, point) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        const blockOffset = liveStrokeOffsets.get(id) || { x: 0, y: 0 };
        stroke.points.push(relativizePoint(point, blockOffset));
        const from = liveDrawnPointCount.get(id) || 0;
        const dpr = window.devicePixelRatio || 1;
        renderStrokeIncremental(ctx, stroke, from, dpr, blockOffset);
        liveDrawnPointCount.set(id, stroke.points.length);
      },
      onStrokeEnd: (id) => {
        const stroke = liveStrokes.get(id);
        if (!stroke) return;
        liveStrokes.delete(id);
        liveDrawnPointCount.delete(id);
        liveStrokeOffsets.delete(id);
        // Marker strokes are drawn live segment-by-segment, which compounds
        // their translucency at the joints into uneven dark spots. Once the
        // stroke is finished (and nothing else is mid-draw), repaint so the
        // marker shows as one even, see-through band — renderStroke draws a
        // highlighter as a single constant-width path.
        if (stroke.highlighter && liveStrokes.size === 0) {
          replayStrokes(canvas, strokes, offsetForStroke);
        }
        const savePromise = addStroke(stroke).catch((err) => {
          console.error('Failed to save stroke:', err);
          notifySaveError();
        });
        pendingStrokeSaves.add(savePromise);
        savePromise.finally(() => pendingStrokeSaves.delete(savePromise));
      }
    });
  }

  function detachPencilIfAny() {
    if (detachPencil) {
      detachPencil();
      detachPencil = null;
    }
  }

  let resizeAndReplayPending = false;
  function resizeAndReplay() {
    if (!canvas || !pageHost) return;
    // Never wipe the canvas mid-stroke — the destination-out / lineWidth
    // state belongs to the live stroke; clearing now would cause artifacts
    // and lose the live stroke's drawn pixels until the next replay.
    if (liveStrokes.size > 0) {
      if (!resizeAndReplayPending) {
        resizeAndReplayPending = true;
        const retry = () => {
          resizeAndReplayPending = false;
          if (liveStrokes.size > 0) {
            // Still drawing — try again after a frame.
            requestAnimationFrame(retry);
          } else {
            resizeAndReplay();
          }
        };
        requestAnimationFrame(retry);
      }
      return;
    }
    // Size against the content wrapper (whose size is driven by the blocks).
    // The canvas lives inside the scrollable page so it scrolls with content.
    sizeCanvas(canvas, pageContent);
    replayStrokes(canvas, strokes, offsetForStroke);
    canvas.classList.toggle('pencil-canvas--active', pencilEnabled);
  }

  async function undoLastStroke() {
    // Pop the most recently created non-live stroke.
    if (strokes.length === 0) return;
    const last = strokes[strokes.length - 1];
    if (liveStrokes.has(last.id)) return; // currently being drawn
    strokes.pop();
    try {
      await deleteStrokeById(last.id);
    } catch (err) {
      console.error('Undo delete failed:', err);
    }
    replayStrokes(canvas, strokes, offsetForStroke);
  }

  async function clearAllStrokes() {
    if (strokes.length === 0) return;
    const ok = await confirmDialog({
      title: 'מחיקת ציורים',
      body: 'למחוק את כל הציורים בדף הזה?',
      confirmLabel: 'מחקי הכל',
      cancelLabel: 'ביטול',
      destructive: true
    });
    if (!ok) return;
    // Snapshot the IDs we're committing to delete. Any new strokes that
    // arrive after this snapshot (e.g. a pointerup completing right now)
    // are intentionally preserved.
    const idsToDelete = strokes.map((s) => s.id);
    const idSet = new Set(idsToDelete);
    // Wait for any in-flight stroke saves to finish first — otherwise a
    // mid-flight save could re-add a stroke we just cleared from IDB.
    await Promise.allSettled([...pendingStrokeSaves]);
    for (const id of idsToDelete) {
      try { await deleteStrokeById(id); } catch (_) {}
    }
    // Drop only the strokes we snapshotted; keep any added during the await.
    for (let i = strokes.length - 1; i >= 0; i -= 1) {
      if (idSet.has(strokes[i].id)) strokes.splice(i, 1);
    }
    replayStrokes(canvas, strokes, offsetForStroke);
  }

  // ---------- input dispatch ----------

  // Hebrew presses go into the same work-block grid the math keypad targets
  // — one Hebrew letter per cell. Hebrew is RTL: typing advances the cursor
  // LEFT, SPACE advances LEFT, NEWLINE drops to the next row's RIGHTMOST
  // column, and BACKSPACE deletes the most recently typed cell (which is to
  // the RIGHT of the current cursor position). Arrow keys still navigate
  // freely so the kid can fix a single letter without deleting through.
  function handleHebrewKey(code) {
    if (code === 'TOGGLE_KEYPAD') {
      setKeypadMode(nextKeypadMode());
      return;
    }
    // Row-label popover has focus — route presses there. Same pattern
    // as the exercise-label chip below; sits above it in the dispatch
    // order so the popover gets the key whenever it's open.
    const rowLabelInput = getFocusedRowLabelInput();
    if (rowLabelInput) return handleRowLabelKey(rowLabelInput, code);
    // Exercise-label chip has focus — route presses into the contenteditable
    // label rather than the work-block cells. Same pattern as annotations.
    const labelEl = getFocusedExerciseLabel();
    if (labelEl) return handleExerciseLabelKey(labelEl, code);
    // Annotation has focus — route presses to insert into the
    // contenteditable instead of the work-block grid. Newline maps to '\n'
    // (annotations support multi-line via white-space: pre-wrap).
    const annotEl = getFocusedAnnotation();
    if (annotEl) {
      if (code === 'BACKSPACE') return annotationBackspace(annotEl);
      if (code === 'SPACE')     return annotationInsert(annotEl, ' ');
      if (code === 'NEWLINE')   return annotationInsert(annotEl, '\n');
      if (code === 'LEFT' || code === 'RIGHT' || code === 'UP' || code === 'DOWN') {
        return annotationMoveCaret(annotEl, code);
      }
      return annotationInsert(annotEl, code);
    }
    if (activeGridAnnot) return handleGridAnnotKey(code);
    if (!activeWorkBlock) return;
    switch (code) {
      case 'BACKSPACE': backspaceRTL(); return;
      case 'SPACE': moveCursor(cursor.r, cursor.c - 1); return;
      case 'NEWLINE':
        moveCursor(cursor.r + 1, activeWorkBlock.cols - 1);
        return;
      case 'LEFT': arrowHorizontal(-1); return;
      case 'RIGHT': arrowHorizontal(1); return;
      case 'UP': arrowVertical(-1); return;
      case 'DOWN': arrowDownToRowStart(); return;
      default:
        // Single Hebrew letter or punctuation — insert as a one-char atom
        // and advance the cursor LEFT so the next letter lands to the
        // left of this one (RTL flow).
        insertCharRTL(code);
    }
  }

  // English keypad: LTR text flow into the same grid. Single ASCII letter
  // (upper- or lowercase) or punctuation gets inserted into the active
  // cell and the cursor advances to the right — same direction as math.
  function handleEnglishKey(code) {
    if (code === 'TOGGLE_KEYPAD') {
      setKeypadMode(nextKeypadMode());
      return;
    }
    const rowLabelInput = getFocusedRowLabelInput();
    if (rowLabelInput) return handleRowLabelKey(rowLabelInput, code);
    const labelEl = getFocusedExerciseLabel();
    if (labelEl) return handleExerciseLabelKey(labelEl, code);
    const annotEl = getFocusedAnnotation();
    if (annotEl) {
      if (code === 'BACKSPACE') return annotationBackspace(annotEl);
      if (code === 'SPACE')     return annotationInsert(annotEl, ' ');
      if (code === 'LEFT' || code === 'RIGHT' || code === 'UP' || code === 'DOWN') {
        return annotationMoveCaret(annotEl, code);
      }
      return annotationInsert(annotEl, code);
    }
    if (activeGridAnnot) return handleGridAnnotKey(code);
    if (!activeWorkBlock) return;
    switch (code) {
      case 'BACKSPACE': backspace(); return;
      case 'SPACE': arrowHorizontal(1); return;
      case 'LEFT': arrowHorizontal(-1); return;
      case 'RIGHT': arrowHorizontal(1); return;
      case 'UP': arrowVertical(-1); return;
      case 'DOWN': arrowDownToRowStart(); return;
      default:
        // Single English letter or punctuation. insertChar already handles
        // shift-row-right when overwriting, edge refusal, and queueSave.
        insertChar(code);
    }
  }

  // Same as insertChar but advances the cursor LEFT (toward c=0) instead of
  // right. Used by the Hebrew keypad so typed text reads right-to-left.
  function insertCharRTL(ch) {
    const r = cursor.r;
    const c = cursor.c;
    const occupiedHere = !!activeWorkBlock.cells[`${r},${c}`];
    const atLeftEdge = c <= 0;
    if (occupiedHere && atLeftEdge) {
      flashRefuse(r, c, { reason: 'edge' });
      notifyAtomEdge();
      return;
    }
    // Occupancy check: if the cursor lands on a non-empty cell (e.g. the
    // kid typed English LTR and now switched to Hebrew on the same row),
    // INSERT before the existing cells by shifting the contiguous run
    // LEFT — analogous to insertChar's shiftRowRightFrom but mirrored
    // for the RTL flow. Without this, the new Hebrew letter silently
    // overwrote the English atom that was sitting at (r, c). Bug
    // surfaced by bilingual-input QA.
    if (occupiedHere) {
      if (!shiftRowLeftFrom(r, c)) {
        flashRefuse(r, c, { reason: 'edge' });
        notifyAtomEdge();
        return;
      }
      pushUndo();
      activeWorkBlock.cells[`${r},${c}`] = { ch };
      // The leftward shift moved cells; updateCell only repaints one
      // so re-render the row.
      rerenderActiveGrid();
      moveCursor(r, c - 1);
      queueSave();
      return;
    }

    pushUndo();
    activeWorkBlock.cells[`${r},${c}`] = { ch };
    updateCell(activeGrid, activeWorkBlock, r, c);
    if (c > 0) {
      moveCursor(r, c - 1);
    } else {
      // Edge: the cell write SUCCEEDED but the cursor can't advance.
      // Don't flash refuse here — the press was accepted. Just notify.
      notifyAtomEdge();
    }
    queueSave();
  }

  // RTL counterpart of shiftRowRightFrom — walks the contiguous non-empty
  // run starting at (r, c) and shifts each cell one column to the LEFT.
  // Returns false when the run already reaches column 0 (or the reserved
  // margin) — caller flashes a refusal.
  function shiftRowLeftFrom(r, c) {
    const anchors = [];
    let k = c;
    while (k >= 0) {
      const here = activeWorkBlock.cells[`${r},${k}`];
      if (!here) break;
      const w = compositeWidth(here);
      anchors.push({ k, w });
      k -= 1;
    }
    if (anchors.length === 0) return true;
    const last = anchors[anchors.length - 1];
    // Can't shift further left if the leftmost anchor is at or beyond
    // the reserved margin.
    if (last.k - 1 < 0) return false;
    // Move from leftmost to rightmost so we don't overwrite a cell we
    // haven't moved yet.
    for (let i = anchors.length - 1; i >= 0; i -= 1) {
      const a = anchors[i];
      activeWorkBlock.cells[`${r},${a.k - 1}`] = activeWorkBlock.cells[`${r},${a.k}`];
      delete activeWorkBlock.cells[`${r},${a.k}`];
    }
    return true;
  }

  // RTL backspace: the most recently typed cell sits to the RIGHT of the
  // cursor (because typing advances left). Delete it, then place the cursor
  // there so the next press overwrites in place.
  function backspaceRTL() {
    pushUndo();
    const r = cursor.r;
    const c = cursor.c;
    const here = getCellAt(r, c);
    if (here) {
      delete activeWorkBlock.cells[`${r},${c}`];
      updateCell(activeGrid, activeWorkBlock, r, c);
      queueSave();
      return;
    }
    if (c + 1 < activeWorkBlock.cols) {
      const nc = c + 1;
      delete activeWorkBlock.cells[`${r},${nc}`];
      updateCell(activeGrid, activeWorkBlock, r, nc);
      moveCursor(r, nc);
      queueSave();
    }
  }

  function handleKey(code) {
    if (code === 'TOGGLE_KEYPAD') {
      setKeypadMode(nextKeypadMode());
      return;
    }
    const rowLabelInput = getFocusedRowLabelInput();
    if (rowLabelInput) return handleRowLabelKey(rowLabelInput, code);
    const labelEl = getFocusedExerciseLabel();
    if (labelEl) return handleExerciseLabelKey(labelEl, code);
    const annotEl = getFocusedAnnotation();
    if (annotEl) return handleAnnotationMathKey(annotEl, code);
    if (activeGridAnnot) return handleGridAnnotKey(code);
    if (!activeWorkBlock) return;
    if (CHAR_KEYS.has(code)) {
      insertChar(code);
      return;
    }
    if (COMPOSITE_KEYS[code]) {
      insertComposite(COMPOSITE_KEYS[code]());
      return;
    }
    switch (code) {
      case 'BACKSPACE': backspace(); break;
      case 'LEFT': arrowHorizontal(-1); break;
      case 'RIGHT': arrowHorizontal(1); break;
      case 'UP': arrowVertical(-1); break;
      case 'DOWN': arrowDownToRowStart(); break;
      case 'EXIT': exitComposite(1); break;
      // Space in math mode advances the cursor right — it doesn't insert a
      // visible space character, since math cells are single atoms.
      case 'SPACE': arrowHorizontal(1); break;
    }
  }

  // ---------- annotation keypad routing ----------
  //
  // Most math-keypad keys insert their character literally. FRAC builds a
  // structured fraction widget (matching the work-block stacked render);
  // the remaining composites have no clean structured representation in a
  // free-text annotation so they fall back to unicode glyphs that the kid
  // can read off the worksheet:
  //   POW    → '²'  (kid retypes ³⁴⁵… as needed)
  //   SQUARE → '²'
  //   SQRT   → '√'
  //   NROOT  → 'ⁿ√'
  //   ABS    → '|'
  //   EXIT   → no-op (no composite to escape from in flat text)
  // SPACE inserts a literal ' ' (unlike work-block math, which uses Space
  // as an advance-cursor). Arrow keys move the caret natively.
  const ANNOT_COMPOSITE_TEXT = {
    POW: '²',
    SQUARE: '²',
    SQRT: '√',
    NROOT: 'ⁿ√',
    ABS: '|'
  };
  function handleAnnotationMathKey(annotEl, code) {
    if (code === 'FRAC') return insertFractionWidget(annotEl);
    if (CHAR_KEYS.has(code)) return annotationInsert(annotEl, code);
    if (ANNOT_COMPOSITE_TEXT[code]) return annotationInsert(annotEl, ANNOT_COMPOSITE_TEXT[code]);
    switch (code) {
      case 'BACKSPACE': return annotationBackspace(annotEl);
      case 'SPACE': return annotationInsert(annotEl, ' ');
      case 'LEFT': case 'RIGHT': case 'UP': case 'DOWN':
        return annotationMoveCaret(annotEl, code);
      case 'EXIT': /* nothing to escape inside plain text */ return;
    }
  }

  // Drop a stacked fraction at the caret. Structured DOM: a non-editable
  // wrapper with two editable plaintext-only slots (numerator + denominator),
  // each carrying inputmode="none" so the iOS keyboard stays suppressed
  // when the kid taps into them. Focus lands in the numerator so the next
  // keypress fills the top of the fraction; the kid taps (or arrows) into
  // the denominator to fill the bottom.
  function insertFractionWidget(annotEl) {
    // No nested fractions for v1 — refuse when the caret already lives
    // inside a fraction slot. Keeps the data model simple and the kid
    // doesn't end up with hard-to-edit doubly-stacked rows.
    if (annotEl.closest('.annot-frac')) return;
    ensureCaretInside(annotEl);

    const frac = document.createElement('span');
    frac.className = 'annot-frac';
    frac.setAttribute('contenteditable', 'false');
    // Force LTR inside the fraction so digit-flow in num/den is always
    // left-to-right even when the surrounding annotation is Hebrew.
    // Without this, a multi-character numerator could render mirrored.
    // (Bilingual QA.)
    frac.setAttribute('dir', 'ltr');

    const num = document.createElement('span');
    num.className = 'annot-frac-num';
    num.setAttribute('contenteditable', 'plaintext-only');
    num.setAttribute('inputmode', 'none');
    num.setAttribute('dir', 'ltr');
    // ZWSP gives the slot a focusable text node + a hit target the kid
    // can tap to position the caret. Stripped on save.
    num.textContent = '​';

    const den = document.createElement('span');
    den.className = 'annot-frac-den';
    den.setAttribute('contenteditable', 'plaintext-only');
    den.setAttribute('inputmode', 'none');
    den.setAttribute('dir', 'ltr');
    den.textContent = '​';

    frac.append(num, den);

    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(frac);
    // Add a trailing ZWSP after the fraction so the caret has somewhere
    // to land when the kid arrows out to the right.
    const after = document.createTextNode('​');
    range.setStartAfter(frac);
    range.insertNode(after);

    // Dispatch the input event BEFORE moving focus into the numerator.
    // Focus-shift fires the root's blur listener, which would otherwise
    // see everTyped=false and delete the annotation. The input handler
    // observes the new .annot-frac and flips everTyped=true first, so
    // the blur cleanup correctly leaves the annotation alone.
    const rootAnnot = annotEl.closest('.worksheet__annot');
    if (rootAnnot) {
      rootAnnot.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Move focus into the numerator with the caret AFTER its ZWSP so the
    // first keypress lands at the visual right (LTR digit flow) or left
    // (RTL letter flow) of the slot, matching how text inputs there feel.
    num.focus();
    const numRange = document.createRange();
    numRange.selectNodeContents(num);
    numRange.collapse(false);
    const numSel = window.getSelection();
    numSel.removeAllRanges();
    numSel.addRange(numRange);
  }

  // Anchor the caret at end-of-text if the selection is missing or
  // outside the annotation (happens on the first press right after the
  // contenteditable receives focus from a tap that didn't land on a text
  // node). Without this, execCommand has nowhere to act and silently
  // no-ops.
  function ensureCaretInside(annotEl) {
    if (document.activeElement !== annotEl) annotEl.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount && annotEl.contains(sel.anchorNode)) return;
    const range = document.createRange();
    range.selectNodeContents(annotEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Insert `text` at the caret. execCommand('insertText') is technically
  // deprecated but is still the most reliable way to put characters into a
  // contenteditable across iPadOS Safari versions: it preserves the
  // browser's undo stack, fires the input event, and handles surrogate
  // pairs / IME edge cases natively. The input event in turn triggers
  // the worksheet.js listener that syncs annot.text and calls queueSave.
  function annotationInsert(annotEl, text) {
    ensureCaretInside(annotEl);
    document.execCommand('insertText', false, text);
  }

  function annotationBackspace(annotEl) {
    ensureCaretInside(annotEl);
    // Special case: backspace inside a fraction slot whose entire fraction
    // (both slots) is empty should kill the whole widget rather than
    // get stuck deleting the slot's ZWSP forever. Without this the kid
    // can land in an empty fraction and not be able to back out.
    if (annotEl.classList.contains('annot-frac-num') ||
        annotEl.classList.contains('annot-frac-den')) {
      const frac = annotEl.closest('.annot-frac');
      if (frac && fractionIsEmpty(frac)) {
        const rootAnnot = frac.closest('.worksheet__annot');
        const parent = frac.parentElement;
        // Place the caret right before the soon-to-vanish fraction so
        // the kid keeps a sensible position to type into.
        const range = document.createRange();
        range.setStartBefore(frac);
        range.collapse(true);
        parent.removeChild(frac);
        if (rootAnnot) {
          rootAnnot.focus();
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          rootAnnot.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
    }
    document.execCommand('delete', false, null);
  }

  // True when both slots of a fraction widget contain no user-typed text
  // (only the ZWSP we sprinkle in to keep them focusable).
  function fractionIsEmpty(frac) {
    const num = frac.querySelector('.annot-frac-num');
    const den = frac.querySelector('.annot-frac-den');
    const text = (s) => (s ? (s.textContent || '').replace(/​/g, '') : '');
    return text(num).length === 0 && text(den).length === 0;
  }

  // Move the caret one character in `dir`. Left/Right are horizontal in
  // the annotation's text flow (Safari handles RTL automatically when the
  // surrounding text is Hebrew). Up/Down are line-wise for multi-line
  // annotations. sel.modify is non-standard but supported everywhere
  // we care about (Safari since 5, Chrome since 4); if it ever throws we
  // fall back silently and let the kid tap-to-position.
  function annotationMoveCaret(annotEl, dir) {
    // UP/DOWN inside a fraction slot moves between num and den
    // (analogous to arrowVertical's behavior in work-block composites).
    // Without this, the line-wise sel.modify just jumped the caret out
    // of the widget entirely. (Bilingual QA.)
    if (dir === 'UP' || dir === 'DOWN') {
      if (annotEl.classList && annotEl.classList.contains('annot-frac-num') && dir === 'DOWN') {
        const den = annotEl.parentElement && annotEl.parentElement.querySelector('.annot-frac-den');
        if (den) { focusSlotEnd(den); return; }
      }
      if (annotEl.classList && annotEl.classList.contains('annot-frac-den') && dir === 'UP') {
        const num = annotEl.parentElement && annotEl.parentElement.querySelector('.annot-frac-num');
        if (num) { focusSlotEnd(num); return; }
      }
    }
    ensureCaretInside(annotEl);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const direction = (dir === 'LEFT' || dir === 'UP') ? 'backward' : 'forward';
    const granularity = (dir === 'UP' || dir === 'DOWN') ? 'line' : 'character';
    try { sel.modify('move', direction, granularity); } catch (_) {}
  }

  function focusSlotEnd(slot) {
    slot.focus();
    const range = document.createRange();
    range.selectNodeContents(slot);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- exercise-label keypad routing ----------
  //
  // The exercise label (".workblock__exercise-label") is a contenteditable
  // chip that the kid taps to override the auto-numbered label. When it
  // has focus we route the in-app keypad's presses into the chip the same
  // way text annotations are driven — execCommand keeps the caret in
  // sync and fires `input`, which triggers handleExerciseLabelEdit to
  // persist the change.

  function getFocusedExerciseLabel() {
    const el = document.activeElement;
    if (!el || !el.classList) return null;
    if (!el.classList.contains('workblock__exercise-label')) return null;
    return el;
  }

  function handleExerciseLabelKey(labelEl, code) {
    if (code === 'EXIT' || code === 'NEWLINE') { labelEl.blur(); return; }
    if (code === 'BACKSPACE') {
      if (document.activeElement !== labelEl) labelEl.focus();
      document.execCommand('delete', false, null);
      return;
    }
    // Mode toggles bubble through the dispatcher above this; arrow keys,
    // SPACE, and composite codes don't make sense inside the short label
    // chip so we silently swallow them rather than emitting garbage text.
    if (code === 'TOGGLE_KEYPAD') return;
    if (code === 'LEFT' || code === 'RIGHT' || code === 'UP' || code === 'DOWN') return;
    if (code === 'SPACE') return;
    // Anything that's a single character (digit, Hebrew letter, ASCII
    // letter, operator) gets inserted at the caret. Composite codes
    // (FRAC, POW, SQRT, …) are multi-character names and filtered out.
    if (typeof code === 'string' && [...code].length === 1) {
      if (document.activeElement !== labelEl) labelEl.focus();
      document.execCommand('insertText', false, code);
    }
  }

  // ---------- row-label popover ----------
  //
  // Tapping the left-margin gutter of a row in a work block opens a
  // small floating editor that lets the kid attach an optional
  // sub-question label (א/ב/1.1/a/…) to that row. The popover is
  // anchored to the gutter overlay but sized for a comfortable typing
  // surface: it slides leftward into the page's left padding when
  // there's room, or rightward over the workblock when there isn't.
  // The in-app keypad routes presses into the popover's contenteditable
  // the same way it routes into the exercise-label chip.
  //
  // The label itself renders centered in the gutter (see grid.js); the
  // popover is the editor, not the display surface.

  function openRowLabelEditor(block, row, overlayEl) {
    // Close any existing popover first. We commit so the kid doesn't
    // lose typing when they jump to label another row mid-edit.
    // closeRowLabelEditor triggers a re-render, which detaches the
    // overlayEl we were passed — so below we re-query a fresh overlay
    // from the DOM before measuring.
    if (activeRowLabel) {
      const sameTarget =
        activeRowLabel.blockId === block.id && activeRowLabel.row === row;
      closeRowLabelEditor({ commit: true });
      // If the kid re-tapped the same gutter, treat that as "I'm done"
      // rather than re-opening the editor immediately — matches how the
      // exercise-label chip behaves (tap → enter, tap-away → exit).
      if (sameTarget) return;
    }
    pushUndo();

    // Re-acquire the overlay from the DOM in case the close above
    // ran a re-render and detached the original element.
    const freshOverlay = pageHost.querySelector(
      `.workblock[data-block-id="${block.id}"] .workblock__row-label[data-r="${row}"]`
    );
    if (!freshOverlay) return; // workblock was removed underneath us
    overlayEl = freshOverlay;

    activeRowLabel = { blockId: block.id, row, popover: null };

    // Drop competing focus targets so the keypad only routes into the
    // popover from here on. Mirrors the focus-mutex logic in onCellTap.
    const annotEl = getFocusedAnnotation();
    if (annotEl) annotEl.blur();
    const labelChip = getFocusedExerciseLabel();
    if (labelChip) labelChip.blur();
    activeGridAnnot = null;
    clearActiveCursorHighlight();

    overlayEl.classList.add('workblock__row-label--editing');

    const pageRect = pageContent.getBoundingClientRect();
    const overlayRect = overlayEl.getBoundingClientRect();

    const popover = document.createElement('div');
    popover.className = 'workblock__row-label-editor';
    popover.setAttribute('dir', 'auto');
    popover.dataset.blockId = block.id;
    popover.dataset.r = String(row);

    const input = document.createElement('span');
    input.className = 'workblock__row-label-editor-input';
    input.setAttribute('contenteditable', 'plaintext-only');
    input.setAttribute('inputmode', 'none');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('dir', 'auto');
    input.setAttribute('aria-label', 'תווית שורה');
    input.textContent = (block.rowLabels && block.rowLabels[row]) || '';
    popover.appendChild(input);

    // Successor hint. Only shown when the PREVIOUS row already has a
    // label that nextRowLabel can advance — otherwise the button has
    // nothing useful to do and would clutter the popover.
    const prevLabel = row > 0 && block.rowLabels ? block.rowLabels[row - 1] : '';
    const suggestion = prevLabel ? nextRowLabel(prevLabel) : '';
    if (suggestion && input.textContent === '') {
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'workblock__row-label-editor-hint';
      hint.textContent = `↓ ${suggestion}`;
      hint.setAttribute('aria-label', `הוסיפי תווית ${suggestion}`);
      hint.addEventListener('mousedown', (e) => e.preventDefault());
      hint.addEventListener('click', (event) => {
        event.stopPropagation();
        input.textContent = suggestion;
        // Re-focus the input + place the caret at the end so the kid
        // can keep typing if they want a longer label.
        focusAtEnd(input);
      });
      popover.appendChild(hint);
    }

    // Position: anchor the popover so it visually points at the gutter
    // overlay's right edge (which sits against the math area). Prefer
    // to extend LEFT into the page padding. If that would clip past
    // the page's left edge, flip rightward and overlay the math area
    // instead. Either way we anchor in #page-content coordinates so
    // the popover scrolls with the workblock.
    pageContent.appendChild(popover);
    // Defer measurement until the element is in the DOM so getBoundingClientRect
    // returns a real size — needed for the rightward-flip decision.
    requestAnimationFrame(() => {
      const popRect = popover.getBoundingClientRect();
      const desiredWidth = Math.max(popRect.width, 140);
      const topInContent = overlayRect.top - pageRect.top - 4;
      const overlayLeftInContent = overlayRect.left - pageRect.left;
      const overlayRightInContent = overlayRect.right - pageRect.left;
      const leftRoom = overlayLeftInContent;
      let left;
      if (leftRoom >= desiredWidth + 8) {
        left = overlayLeftInContent - desiredWidth - 6;
      } else {
        // Not enough room to the left — slide rightward to overlay
        // the math area (still readable; the kid is editing this row,
        // so covering its right side briefly is acceptable).
        left = overlayRightInContent + 6;
      }
      popover.style.top = `${topInContent}px`;
      popover.style.left = `${left}px`;
    });

    activeRowLabel.popover = popover;

    // Focus the input + select all so a quick label-overwrite (e.g.
    // the kid is changing "א" to "ב") feels natural — first keypress
    // replaces the existing text instead of appending.
    requestAnimationFrame(() => {
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    // Commit on outside-tap. Listener is single-shot per popover so
    // we don't have to track it across re-renders. Critical: taps on
    // the in-app keypad (.editor__keypad-host) and the keypad's
    // show/hide chrome must NOT count as "outside" — the keypad is
    // the kid's input device while the popover is open. Without this
    // exemption, the very first keypad press fires this capture-phase
    // handler before the bubble-phase routing reaches the popover, so
    // the popover dismisses and the character ends up in a math cell.
    const outsideHandler = (event) => {
      if (!activeRowLabel || activeRowLabel.popover !== popover) {
        document.removeEventListener('pointerdown', outsideHandler, true);
        return;
      }
      if (popover.contains(event.target)) return;
      if (event.target.closest) {
        if (event.target.closest('.workblock__row-label')) {
          // Tapping a different row-label gutter — let its own click
          // handler fire openRowLabelEditor which will close+reopen for us.
          return;
        }
        if (event.target.closest('.editor__keypad-host') ||
            event.target.closest('#keypad-show')) {
          // Keypad press or keypad show/hide chrome — part of the
          // popover's input flow, not a dismissal.
          return;
        }
      }
      document.removeEventListener('pointerdown', outsideHandler, true);
      closeRowLabelEditor({ commit: true });
    };
    document.addEventListener('pointerdown', outsideHandler, true);

    // Native Enter on a hardware keyboard also commits.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        closeRowLabelEditor({ commit: true });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeRowLabelEditor({ commit: false });
      }
    });
  }

  function closeRowLabelEditor({ commit }) {
    if (!activeRowLabel) return;
    const { blockId, row, popover } = activeRowLabel;
    activeRowLabel = null;
    if (commit) {
      const block = page.blocks.find((b) => b.id === blockId);
      if (block && block.type === BLOCK.WORK) {
        if (!block.rowLabels) block.rowLabels = {};
        const input = popover && popover.querySelector('.workblock__row-label-editor-input');
        const raw = input ? (input.textContent || '') : '';
        const cleaned = raw.replace(/\s+/g, ' ').trim();
        const had = !!block.rowLabels[row];
        if (cleaned) {
          if (block.rowLabels[row] !== cleaned) {
            block.rowLabels[row] = cleaned;
            queueSave();
          }
        } else if (had) {
          delete block.rowLabels[row];
          queueSave();
        }
      }
    }
    if (popover && popover.parentElement) popover.parentElement.removeChild(popover);
    // Clear the editing highlight on whichever overlay was active. The
    // overlay element may have been re-rendered out from under us, in
    // which case the next render will simply not paint the class — no
    //-op here, no crash.
    if (pageHost) {
      pageHost.querySelectorAll('.workblock__row-label--editing').forEach((el) =>
        el.classList.remove('workblock__row-label--editing')
      );
    }
    // Re-render so the committed label paints in the gutter (or clears
    // if it was emptied).
    renderBlocks();
  }

  // Returns the popover's input element whenever the row-label editor
  // is open. We deliberately do NOT gate on document.activeElement
  // matching the input — iPadOS Safari briefly moves focus to a
  // tapped keypad button between pointerdown and click, even when the
  // button mousedown-preventDefaults, and an activeElement check
  // would then return null and route the keypress to a math cell.
  // The popover is effectively modal while open (mutex with grid
  // cursor, exercise label, and worksheet annotations), so as long
  // as activeRowLabel is set we route to its input. handleRowLabelKey
  // re-focuses the input before execCommand so the caret is always
  // in the right place when the character lands.
  function getFocusedRowLabelInput() {
    if (!activeRowLabel || !activeRowLabel.popover) return null;
    const input = activeRowLabel.popover.querySelector(
      '.workblock__row-label-editor-input'
    );
    return input || null;
  }

  function handleRowLabelKey(inputEl, code) {
    if (code === 'EXIT' || code === 'NEWLINE') {
      closeRowLabelEditor({ commit: true });
      return;
    }
    if (code === 'BACKSPACE') {
      if (document.activeElement !== inputEl) inputEl.focus();
      document.execCommand('delete', false, null);
      return;
    }
    // Mode toggles bubble through the dispatcher above; arrow keys
    // and composite codes don't make sense in a short label so swallow.
    if (code === 'TOGGLE_KEYPAD') return;
    if (code === 'LEFT' || code === 'RIGHT' || code === 'UP' || code === 'DOWN') return;
    if (code === 'SPACE') return;
    if (typeof code === 'string' && [...code].length === 1) {
      if (document.activeElement !== inputEl) inputEl.focus();
      document.execCommand('insertText', false, code);
    }
  }

  // Place the caret at the end of `el` (a contenteditable). Used after
  // the auto-successor hint button writes a value so the kid can keep
  // editing if they want a longer label.
  function focusAtEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // ---------- grid-annotation keypad routing ----------
  //
  // Counterpart to the work-block input handlers but scoped to whichever
  // grid annotation is currently focused (activeGridAnnot). v1 is
  // atom-only — single-character cells, no composites — because the
  // primary use case is a short calculation under a printed worksheet
  // question. Cell DOM is updated in-place via updateGridAnnotCellDOM /
  // updateGridAnnotCursor so typing doesn't force a full renderBlocks
  // every keystroke.

  function handleGridAnnotKey(code) {
    if (!activeGridAnnot) return;
    const block = page.blocks.find((b) => b.id === activeGridAnnot.worksheetBlockId);
    if (!block) { activeGridAnnot = null; return; }
    const annot = (block.annotations || []).find((a) => a.id === activeGridAnnot.annotId);
    if (!annot || !isGridAnnotation(annot)) { activeGridAnnot = null; return; }

    const cur = activeGridAnnot.cursor;
    const cell = annot.cells && annot.cells[`${cur.r},${cur.c}`];

    // Inside a composite slot (cursor entered a fraction's num/den) the
    // dispatch is slot-local: chars append to the slot, arrows step
    // between slots or exit, backspace clears within the slot.
    if (cur.slot && isComposite(cell)) {
      return handleGridAnnotSlotKey(annot, cell, code);
    }

    // Cell-level dispatch when the cursor isn't inside a slot.
    if (code === 'EXIT') { activeGridAnnot = null; renderBlocks(); return; }
    if (code === 'FRAC') return gridAnnotInsertFraction(annot);
    if (code === 'BACKSPACE') return gridAnnotBackspace(annot);
    if (code === 'LEFT')  return gridAnnotMoveCursor(annot, 0, -1);
    if (code === 'RIGHT') return gridAnnotMoveCursor(annot, 0, +1);
    if (code === 'UP')    return gridAnnotMoveCursor(annot, -1, 0);
    if (code === 'DOWN')  return gridAnnotMoveCursor(annot, +1, 0);
    if (code === 'SPACE') return gridAnnotMoveCursor(annot, 0, +1);
    if (code === 'NEWLINE') {
      // ⏎: drop to the next row, column 0 — mirrors how the kid moves
      // between steps in a worksheet calculation.
      gridAnnotSetCursor(annot, Math.min(annot.rows - 1, cur.r + 1), 0);
      return;
    }
    // If the cursor lands on an existing composite cell, enter its first
    // slot before treating subsequent keys (so '5' after navigating onto
    // a fraction lands inside the numerator instead of overwriting the
    // composite with an atom).
    if (isComposite(cell)) {
      cur.slot = compositeSlots(cell)[0] || null;
      gridAnnotRepaintCell(annot, cur.r, cur.c);
      if (typeof code === 'string' && [...code].length === 1) {
        return handleGridAnnotSlotKey(annot, cell, code);
      }
      return;
    }
    if (typeof code === 'string' && [...code].length === 1) {
      return gridAnnotInsertChar(annot, code);
    }
  }

  // Slot-local dispatch — used when the cursor is inside a composite
  // cell's slot (e.g. typing into a fraction's numerator). Mirrors the
  // work-block slot semantics (arrow up/down toggles between num/den,
  // arrow left/right exits the composite, backspace deletes from the
  // slot or collapses an empty composite).
  function handleGridAnnotSlotKey(annot, cell, code) {
    const cur = activeGridAnnot.cursor;
    if (code === 'EXIT') {
      cur.slot = null;
      gridAnnotRepaintCell(annot, cur.r, cur.c);
      return;
    }
    if (code === 'BACKSPACE') return gridAnnotSlotBackspace(annot, cell);
    if (code === 'UP') {
      if (cell.type === 'fraction' && cur.slot === 'den') {
        cur.slot = 'num';
        gridAnnotRepaintCell(annot, cur.r, cur.c);
        return;
      }
      // Exit composite upward into the row above (or stay if at top).
      cur.slot = null;
      gridAnnotMoveCursor(annot, -1, 0);
      return;
    }
    if (code === 'DOWN') {
      if (cell.type === 'fraction' && cur.slot === 'num') {
        cur.slot = 'den';
        gridAnnotRepaintCell(annot, cur.r, cur.c);
        return;
      }
      cur.slot = null;
      gridAnnotMoveCursor(annot, +1, 0);
      return;
    }
    if (code === 'LEFT') {
      cur.slot = null;
      gridAnnotMoveCursor(annot, 0, -1);
      return;
    }
    if (code === 'RIGHT' || code === 'SPACE') {
      cur.slot = null;
      gridAnnotMoveCursor(annot, 0, +1);
      return;
    }
    if (code === 'NEWLINE') {
      cur.slot = null;
      gridAnnotSetCursor(annot, Math.min(annot.rows - 1, cur.r + 1), 0);
      return;
    }
    if (code === 'FRAC') {
      // Nested fractions aren't supported in slots (string-only model);
      // fall back silently rather than corrupting the model.
      return;
    }
    if (typeof code === 'string' && [...code].length === 1) {
      return gridAnnotAppendToSlot(annot, cell, code);
    }
  }

  function gridAnnotInsertChar(annot, ch) {
    pushUndo();
    if (!annot.cells) annot.cells = {};
    const cur = activeGridAnnot.cursor;
    annot.cells[`${cur.r},${cur.c}`] = { ch };
    gridAnnotRepaintCell(annot, cur.r, cur.c);
    // Advance to the next cell. Wrap to the next row when we run off
    // the right edge — keeps the kid moving forward without manual
    // arrow taps for long calculations.
    let nr = cur.r;
    let nc = cur.c + 1;
    if (nc >= annot.cols) {
      if (cur.r + 1 < annot.rows) { nr = cur.r + 1; nc = 0; }
      else nc = cur.c; // bottom-right corner: stay put, kid backspaces or resizes
    }
    gridAnnotSetCursor(annot, nr, nc);
    queueSave();
  }

  // Drop a fresh fraction composite at the cursor. If the cursor is on
  // an atom (e.g. the kid typed '5' then pressed FRAC), promote that
  // atom into the numerator and land the cursor in the denominator,
  // matching the work-block FRAC behaviour.
  function gridAnnotInsertFraction(annot) {
    pushUndo();
    if (!annot.cells) annot.cells = {};
    const cur = activeGridAnnot.cursor;
    const existing = annot.cells[`${cur.r},${cur.c}`];
    let composite;
    let landSlot;
    if (existing && existing.ch != null) {
      composite = newFractionCell(existing.ch, '');
      landSlot = 'den';
    } else if (isComposite(existing)) {
      // Already a composite — don't overwrite; enter its first slot.
      cur.slot = compositeSlots(existing)[0] || null;
      gridAnnotRepaintCell(annot, cur.r, cur.c);
      return;
    } else {
      composite = newFractionCell();
      landSlot = 'num';
    }
    annot.cells[`${cur.r},${cur.c}`] = composite;
    cur.slot = landSlot;
    gridAnnotRepaintCell(annot, cur.r, cur.c);
    queueSave();
  }

  function gridAnnotAppendToSlot(annot, cell, ch) {
    pushUndo();
    const cur = activeGridAnnot.cursor;
    const slotName = cur.slot;
    cell[slotName] = (cell[slotName] || '') + ch;
    gridAnnotRepaintCell(annot, cur.r, cur.c);
    queueSave();
  }

  function gridAnnotSlotBackspace(annot, cell) {
    pushUndo();
    const cur = activeGridAnnot.cursor;
    const slotName = cur.slot;
    const current = cell[slotName] || '';
    if (current.length > 0) {
      cell[slotName] = current.slice(0, -1);
      gridAnnotRepaintCell(annot, cur.r, cur.c);
      queueSave();
      return;
    }
    // Slot empty — collapse the composite when ALL slots are empty,
    // otherwise jump to the previous slot.
    const slots = compositeSlots(cell);
    const allEmpty = slots.every((s) => !cell[s]);
    if (allEmpty) {
      delete annot.cells[`${cur.r},${cur.c}`];
      cur.slot = null;
      gridAnnotRepaintCell(annot, cur.r, cur.c);
      queueSave();
      return;
    }
    const idx = slots.indexOf(slotName);
    if (idx > 0) {
      cur.slot = slots[idx - 1];
      gridAnnotRepaintCell(annot, cur.r, cur.c);
    }
  }

  function gridAnnotBackspace(annot) {
    pushUndo();
    if (!annot.cells) annot.cells = {};
    const cur = activeGridAnnot.cursor;
    const key = `${cur.r},${cur.c}`;
    if (annot.cells[key]) {
      delete annot.cells[key];
      gridAnnotRepaintCell(annot, cur.r, cur.c);
      queueSave();
      return;
    }
    if (cur.c > 0) {
      gridAnnotSetCursor(annot, cur.r, cur.c - 1);
      const prevKey = `${cur.r},${cur.c}`;
      if (annot.cells[prevKey]) {
        delete annot.cells[prevKey];
        gridAnnotRepaintCell(annot, cur.r, cur.c);
        queueSave();
      }
    } else if (cur.r > 0) {
      gridAnnotSetCursor(annot, cur.r - 1, annot.cols - 1);
      const prevKey = `${cur.r},${cur.c}`;
      if (annot.cells[prevKey]) {
        delete annot.cells[prevKey];
        gridAnnotRepaintCell(annot, cur.r, cur.c);
        queueSave();
      }
    }
  }

  function gridAnnotMoveCursor(annot, dr, dc) {
    const cur = activeGridAnnot.cursor;
    const nr = Math.max(0, Math.min(annot.rows - 1, cur.r + dr));
    const nc = Math.max(0, Math.min(annot.cols - 1, cur.c + dc));
    gridAnnotSetCursor(annot, nr, nc);
  }

  function gridAnnotSetCursor(annot, r, c) {
    const cur = activeGridAnnot.cursor;
    if (cur.r === r && cur.c === c && !cur.slot) return;
    const prevR = cur.r;
    const prevC = cur.c;
    cur.r = r;
    cur.c = c;
    cur.slot = null;
    // Repaint both cells: prev to remove the cursor highlight + clear
    // any active-slot styling, new to add the cursor class.
    gridAnnotRepaintCell(annot, prevR, prevC);
    gridAnnotRepaintCell(annot, cur.r, cur.c);
  }

  // Repaint a single cell with its current value and the cursor's slot
  // (when the cursor is parked on this cell). Adds the cursor class
  // when the cell is the active one. Uses paintCell from grid.js so
  // composites render the same way as in the main work area.
  function gridAnnotRepaintCell(annot, r, c) {
    const annotEl = document.querySelector(`.worksheet__annot--grid[data-annot-id="${annot.id}"]`);
    if (!annotEl) return;
    const cellEl = annotEl.querySelector(`.gridannot__cell[data-r="${r}"][data-c="${c}"]`);
    if (!cellEl) return;
    const cur = activeGridAnnot.cursor;
    const isCursor = cur.r === r && cur.c === c;
    const cell = annot.cells && annot.cells[`${r},${c}`];
    paintCell(cellEl, cell, isCursor ? (cur.slot || null) : null);
    cellEl.classList.toggle('gridannot__cell--cursor', isCursor);
  }

  function getCellAt(r, c) {
    return activeWorkBlock.cells[`${r},${c}`];
  }

  function insertChar(ch) {
    pushUndo();
    const r = cursor.r;
    const c = cursor.c;
    const cell = getCellAt(r, c);

    if (cursor.slot) {
      if (!isComposite(cell)) {
        cursor.slot = null;
      } else {
        return appendToSlot(cell, r, c, cursor.slot, ch);
      }
    }

    // Defensive: cursor without slot but landed on a composite cell.
    // Enter the first slot rather than overwriting the composite.
    if (isComposite(cell)) {
      const firstSlot = compositeSlots(cell)[0];
      if (firstSlot) {
        cursor.slot = firstSlot;
        return appendToSlot(cell, r, c, firstSlot, ch);
      }
    }

    // If the cursor is parked on a non-empty atom, INSERT before it: shift
    // the contiguous run of cells starting at (r, c) one column to the right
    // and place the new char at (r, c). This is what lets the kid go back
    // and fix a calculation by typing the missing prefix — e.g. correcting
    // "x=18" into "2x=18" by tapping the 'x' and pressing '2', without
    // having to delete and re-enter the rest of the line.
    if (activeWorkBlock.cells[`${r},${c}`]) {
      if (!shiftRowRightFrom(r, c)) {
        flashRefuse(r, c, { reason: 'edge' });
        notifyAtomEdge();
        return;
      }
      activeWorkBlock.cells[`${r},${c}`] = { ch };
      // Multiple cells moved; updateCell only repaints one, so re-render
      // the whole grid in place. The active grid is preserved.
      rerenderActiveGrid();
      moveCursor(r, c + 1);
      queueSave();
      return;
    }

    activeWorkBlock.cells[`${r},${c}`] = { ch };
    updateCell(activeGrid, activeWorkBlock, r, c);
    if (c + 1 < activeWorkBlock.cols) {
      moveCursor(r, c + 1);
    } else {
      // Cell accepted but cursor cannot advance — warn now, before the next
      // press would overwrite. The toast is throttled inside notifyAtomEdge.
      flashRefuse(r, c, { reason: 'edge' });
      notifyAtomEdge();
    }
    queueSave();
  }

  // Shift the contiguous run of non-empty cells in row `r` starting at column
  // `c` one column to the right. Returns false (and leaves the model
  // untouched) when the run already reaches the grid edge — caller flashes a
  // refusal so the kid sees the press didn't take.
  function shiftRowRightFrom(r, c) {
    const anchors = [];
    let k = c;
    while (k < activeWorkBlock.cols) {
      const here = activeWorkBlock.cells[`${r},${k}`];
      if (!here) break;
      const w = compositeWidth(here);
      anchors.push({ k, w });
      k += w;
    }
    if (anchors.length === 0) return true;
    const last = anchors[anchors.length - 1];
    // After shifting, the rightmost anchor lands at last.k + 1 and covers
    // last.k + 1 .. last.k + last.w. Refuse if that overflows the grid.
    if (last.k + last.w >= activeWorkBlock.cols) return false;
    // Walk in reverse so the destination of one anchor isn't the source
    // of the next (otherwise the rightmost cell would clobber its neighbor
    // before the neighbor has been moved).
    for (let i = anchors.length - 1; i >= 0; i -= 1) {
      const { k: kk } = anchors[i];
      const cellVal = activeWorkBlock.cells[`${r},${kk}`];
      delete activeWorkBlock.cells[`${r},${kk}`];
      activeWorkBlock.cells[`${r},${kk + 1}`] = cellVal;
    }
    return true;
  }

  // Append a char into a composite slot, expanding the cell's width if the
  // slot grows. Refuses to expand when the next column is taken (directly
  // or by another wider anchor) or beyond the grid edge — and flashes the
  // cell so the kid knows the press didn't take. On a grid-edge refusal we
  // also surface a Hebrew toast so the kid has a recovery path instead of
  // just a silent red flash (see reference/long fraction.jpeg).
  function appendToSlot(cell, r, c, slot, ch) {
    const oldWidth = compositeWidth(cell);
    const tentativeValue = (cell[slot] || '') + ch;
    const hypothetical = { ...cell, [slot]: tentativeValue };
    const newWidth = compositeWidth(hypothetical);

    if (newWidth > oldWidth) {
      for (let i = oldWidth; i < newWidth; i += 1) {
        const nextC = c + i;
        if (nextC >= activeWorkBlock.cols) {
          flashRefuse(r, c, { reason: 'edge' });
          notifyFractionEdge();
          return;
        }
        if (activeWorkBlock.cells[`${r},${nextC}`]) {
          flashRefuse(r, c);
          return;
        }
        if (findOccupyingAnchor(activeWorkBlock, r, nextC)) {
          flashRefuse(r, c);
          return;
        }
      }
    }

    cell[slot] = tentativeValue;
    if (newWidth !== oldWidth) {
      rerenderActiveGrid();
    } else {
      repaintCell(r, c);
    }
    queueSave();
  }

  // Toast the kid once per ~5s when a fraction can't grow because it hit
  // the grid edge. Without this, the only feedback is a 260ms red flash on
  // the cell — easy to miss, and gives no hint about what to do next.
  let lastFractionEdgeToastAt = 0;
  function notifyFractionEdge() {
    const now = Date.now();
    if (now - lastFractionEdgeToastAt < 5000) return;
    lastFractionEdgeToastAt = now;
    toast('השבר ארוך מדי לשורה — נסי מספרים קצרים יותר או הוסיפי אזור פתרון חדש.', {
      kind: 'warn',
      duration: 3600
    });
  }

  // Same idea for plain atoms hitting the right (or left, in Hebrew) edge.
  // Without it the cursor parks on the last cell and the next press silently
  // overwrites — a quiet failure mode that's especially bad for a kid with a
  // writing disability. Throttled separately from the fraction toast so the
  // two messages don't suppress each other.
  let lastAtomEdgeToastAt = 0;
  function notifyAtomEdge() {
    const now = Date.now();
    if (now - lastAtomEdgeToastAt < 5000) return;
    lastAtomEdgeToastAt = now;
    toast('הגעת לסוף השורה — גררי את הפינה ⤡ כדי להרחיב, או עברי לשורה הבאה.', {
      kind: 'warn',
      duration: 3600
    });
  }

  // POW pressed inside a slot: cycle the trailing superscript digit (²→³→⁴…)
  // if present, otherwise append ². The kid taps once for square, twice for
  // cube, etc., without us needing a separate key per power.
  function appendSuperscriptToSlot(cell, r, c, slot) {
    const current = cell[slot] || '';
    const last = current.slice(-1);
    if (SUPERSCRIPT_NEXT.has(last)) {
      const next = SUPERSCRIPT_NEXT.get(last);
      return replaceSlotTail(cell, r, c, slot, current.slice(0, -1) + next);
    }
    return appendCharToSlot(cell, r, c, slot, '²');
  }

  // Append a literal char to a slot — same width-expansion guard as
  // appendToSlot. Kept separate from insertChar's typing path so the kid
  // can't end up in the "cursor.slot but cell isn't composite" branch.
  function appendCharToSlot(cell, r, c, slot, ch) {
    return appendToSlot(cell, r, c, slot, ch);
  }

  // For superscript cycling: replace the slot value entirely (length stays
  // the same so we never need to re-check width or rerender the grid).
  function replaceSlotTail(cell, r, c, slot, newValue) {
    cell[slot] = newValue;
    repaintCell(r, c);
    queueSave();
  }

  // Briefly flash a cell red to indicate "no room — input refused". When the
  // refusal is because we hit the grid edge (vs. a neighbor cell being taken),
  // also pulse the resize handle so the kid's eye is drawn to the recovery
  // affordance — without that, the ⤡ glyph is easy to miss in the corner.
  function flashRefuse(r, c, { reason } = {}) {
    if (!activeGrid) return;
    const el = activeGrid.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
    if (el) {
      el.classList.add('cell--refuse');
      setTimeout(() => el.classList.remove('cell--refuse'), 260);
    }
    if (reason === 'edge') pulseResizeHandle();
  }

  function pulseResizeHandle() {
    const wrapper = activeGrid && activeGrid.parentElement;
    if (!wrapper) return;
    const handle = wrapper.querySelector('.workblock__resize');
    if (!handle) return;
    handle.classList.remove('workblock__resize--pulse');
    // Force reflow so the animation restarts even on rapid repeat refusals.
    void handle.offsetWidth;
    handle.classList.add('workblock__resize--pulse');
    setTimeout(() => handle.classList.remove('workblock__resize--pulse'), 1200);
  }

  function insertComposite(template) {
    pushUndo();
    const r = cursor.r;
    const c = cursor.c;
    if (cursor.slot) {
      // Composites can't be nested into a slot's string model, but POW and
      // SQRT are common enough inside fractions that we handle them inline:
      // POW appends/cycles a unicode superscript digit, SQRT prepends a √.
      // FRAC inside a slot still falls through to "exit and create new".
      const cell = getCellAt(r, c);
      if (isComposite(cell)) {
        if (template.type === 'pow') {
          return appendSuperscriptToSlot(cell, r, c, cursor.slot);
        }
        if (template.type === 'sqrt') {
          return appendCharToSlot(cell, r, c, cursor.slot, '√');
        }
      }
      // FRAC (or any unhandled composite): exit and create new outside.
      exitComposite(1);
      return insertComposite(template);
    }

    // Special UX for fractions: when FRAC is pressed while pointing at a cell
    // that already holds an atom, promote that atom into the numerator and
    // leave the denominator blank — cursor lands in the den slot ready for
    // input. This matches how a kid writes "5 over what?" on paper.
    //
    // We only promote when the cursor is ON a filled atom cell. The "atom is
    // to the left" case is intentionally NOT handled (unlike POW), because
    // after typing an atom the cursor advances past it, and pressing FRAC
    // there should create a fresh fraction in the *empty* cell — not retro-
    // actively swallow the previous character.
    {
      const here = getCellAt(r, c);
      if (template.type === 'fraction' && here && here.ch != null) {
        const promoted = { type: 'fraction', num: here.ch, den: '' };
        activeWorkBlock.cells[`${r},${c}`] = promoted;
        // Promoted fraction's width may be 1 (single-char num, empty den) so
        // a full grid rerender is unnecessary; updateCell repaints in place.
        updateCell(activeGrid, activeWorkBlock, r, c);
        moveCursorTo(r, c, 'den');
        queueSave();
        return;
      }
    }

    // Special UX for exponents: when typed right after an atom, "promote"
    // that atom into the base of a new pow cell. Two cases:
    //  - cursor is on an empty cell with an atom immediately to its left
    //    (the typical "type x, then xⁿ" flow)
    //  - cursor sits ON an atom (user navigated back onto it)
    // SQUARE arrives here as a pow template with exp pre-filled to '2'.
    // When that's the case we keep the pre-fill and skip entering the exp
    // slot so the cursor lands ready for the next atom.
    if (template.type === 'pow') {
      const presetExp = template.exp || '';
      const enterSlot = presetExp ? null : 'exp';
      const here = getCellAt(r, c);
      if (here && here.ch != null) {
        const promoted = { type: 'pow', base: here.ch, exp: presetExp };
        activeWorkBlock.cells[`${r},${c}`] = promoted;
        updateCell(activeGrid, activeWorkBlock, r, c);
        if (enterSlot) moveCursorTo(r, c, enterSlot);
        else if (c + 1 < activeWorkBlock.cols) moveCursor(r, c + 1);
        queueSave();
        return;
      }
      if (c > 0) {
        const prev = getCellAt(r, c - 1);
        if (prev && prev.ch != null) {
          const promoted = { type: 'pow', base: prev.ch, exp: presetExp };
          activeWorkBlock.cells[`${r},${c - 1}`] = promoted;
          updateCell(activeGrid, activeWorkBlock, r, c - 1);
          if (enterSlot) moveCursorTo(r, c - 1, enterSlot);
          // No prev-atom advance for SQUARE: the cursor already sits at c
          // (just past the promoted base), which is exactly where the next
          // character should land.
          queueSave();
          return;
        }
      }
      // SQUARE (pow with presetExp) with NO atom to promote — refuse
      // rather than dropping a base-less '²' floating on a blank cell.
      // (Math QA bug.) Plain POW (no presetExp) falls through to the
      // generic insert path so the kid can type the base manually
      // afterwards.
      if (presetExp) {
        flashRefuse(r, c);
        return;
      }
    }

    const existing = getCellAt(r, c);
    // If the cursor is on a cell with content, advance past its full width
    // (wide composites take more than one column) and refuse if the next
    // position is also taken — never silently overwrite an existing cell.
    let targetR = r;
    let targetC = c;
    if (existing) {
      targetC = c + compositeWidth(existing);
      if (targetC >= activeWorkBlock.cols) {
        flashRefuse(r, c, { reason: 'edge' });
        notifyAtomEdge();
        return;
      }
      if (
        activeWorkBlock.cells[`${targetR},${targetC}`] ||
        findOccupyingAnchor(activeWorkBlock, targetR, targetC)
      ) {
        flashRefuse(r, c);
        return;
      }
    } else if (findOccupyingAnchor(activeWorkBlock, targetR, targetC)) {
      // The current cell IS occupied (visually rendered as part of a wider
      // composite to the left). Refuse rather than corrupt the model.
      flashRefuse(r, c);
      return;
    }
    activeWorkBlock.cells[`${targetR},${targetC}`] = template;
    const slots = compositeSlots(template);
    updateCell(activeGrid, activeWorkBlock, targetR, targetC);
    moveCursorTo(targetR, targetC, slots[0] || null);
    queueSave();
  }

  function backspace() {
    pushUndo();
    const r = cursor.r;
    const c = cursor.c;
    const here = getCellAt(r, c);

    if (cursor.slot) {
      // Editing a composite slot.
      if (!isComposite(here)) {
        cursor.slot = null;
      } else {
        const current = here[cursor.slot] || '';
        if (current.length > 0) {
          const oldWidth = compositeWidth(here);
          here[cursor.slot] = current.slice(0, -1);
          const newWidth = compositeWidth(here);
          if (newWidth !== oldWidth) rerenderActiveGrid();
          else repaintCell(r, c);
          queueSave();
          return;
        }
        // Slot is empty.
        if (isCompositeEmpty(here)) {
          // Collapse the empty composite. Re-render in case it was wide.
          const wasWide = compositeWidth(here) > 1;
          delete activeWorkBlock.cells[`${r},${c}`];
          cursor.slot = null;
          if (wasWide) rerenderActiveGrid();
          else repaintCell(r, c);
          queueSave();
          return;
        }
        // Slot empty but other slots have content: jump to previous slot.
        const slots = compositeSlots(here);
        const idx = slots.indexOf(cursor.slot);
        if (idx > 0) {
          cursor.slot = slots[idx - 1];
          repaintCell(r, c);
        }
        return;
      }
    }

    // Atomic backspace: clear current cell, or move left and clear.
    if (here) {
      delete activeWorkBlock.cells[`${r},${c}`];
      updateCell(activeGrid, activeWorkBlock, r, c);
      queueSave();
      return;
    }
    if (c > 0) {
      const nc = c - 1;
      delete activeWorkBlock.cells[`${r},${nc}`];
      updateCell(activeGrid, activeWorkBlock, r, nc);
      moveCursor(r, nc);
      queueSave();
    } else {
      // At column 0 with no cell here — backspace has nowhere to go.
      // Was previously a silent no-op; Math QA flagged the lack of
      // feedback. Flash the cell red briefly so the kid sees the press
      // registered. (Throttled via notifyAtomEdge for the toast.)
      flashRefuse(r, c, { reason: 'edge' });
    }
  }

  function arrowHorizontal(dir) {
    if (cursor.slot) {
      // Inside a composite slot, ←/→ exit the composite to that side.
      // autoEnterSlot:false means we don't immediately re-enter the next
      // composite — the user is trying to leave the current one.
      exitComposite(dir);
      return;
    }
    if (dir > 0) {
      // Skip past the full width of the current cell (wide fractions).
      const here = getCellAt(cursor.r, cursor.c);
      const advance = here ? compositeWidth(here) : 1;
      moveCursor(cursor.r, cursor.c + advance);
    } else {
      // Going left: if (c - 1) is occupied by a wider anchor, jump to the
      // anchor's column rather than land on a phantom cell.
      const targetC = cursor.c - 1;
      const occupyingAnchor = findOccupyingAnchor(activeWorkBlock, cursor.r, targetC);
      moveCursor(cursor.r, occupyingAnchor ? occupyingAnchor.c : targetC);
    }
  }

  // First writable cell of a row, honouring the active keypad's text
  // direction: leftmost (MARGIN_COLS) for the LTR math/English keypads,
  // rightmost (cols-1) for the RTL Hebrew keypad.
  function rowStartCol() {
    return keypadMode === 'hebrew' ? activeWorkBlock.cols - 1 : MARGIN_COLS;
  }

  // Down arrow. Inside a fraction/power/root it steps DOWN within the
  // composite (e.g. numerator → denominator) and stays in the same cell.
  // Otherwise it drops to the FIRST cell of the row below — direction-aware
  // (left for LTR, right for RTL Hebrew) — and at the LAST row it grows the
  // block by one and lands on the new row, so the kid can keep going down
  // without reaching for the ➕↕ button (capped at the 40-row resize max).
  async function arrowDownToRowStart() {
    if (!activeWorkBlock) return;
    // Step within a composite first; only fall through to the line-feed when
    // there's no lower slot to move into (mirrors arrowVertical's ↓ mapping).
    if (cursor.slot) {
      const cell = getCellAt(cursor.r, cursor.c);
      if (isComposite(cell)) {
        const slots = compositeSlots(cell);
        const idx = slots.indexOf(cursor.slot);
        let nextIdx = -1;
        if (cell.type === 'fraction') nextIdx = idx < slots.length - 1 ? idx + 1 : -1;
        else if (cell.type === 'pow') nextIdx = idx === 1 ? 0 : -1;
        else if (cell.type === 'nroot') nextIdx = idx === 0 ? 1 : -1;
        if (nextIdx !== -1) {
          cursor.slot = slots[nextIdx];
          repaintCell(cursor.r, cursor.c);
          return;
        }
      }
    }
    cursor.slot = null;
    if (cursor.r >= activeWorkBlock.rows - 1) {
      if (activeWorkBlock.rows >= 40) {
        toast('הגעת למספר השורות המרבי.', { kind: 'warn', duration: 2400 });
        moveCursor(cursor.r, rowStartCol());
        return;
      }
      pushUndo();
      activeWorkBlock.rows += 1;
      cursor.r = activeWorkBlock.rows - 1;
      cursor.c = clamp(rowStartCol(), MARGIN_COLS, activeWorkBlock.cols - 1);
      await savePage(page);
      await renderBlocks();
      return;
    }
    moveCursor(cursor.r + 1, rowStartCol());
  }

  function arrowVertical(dir) {
    if (cursor.slot) {
      const cell = getCellAt(cursor.r, cursor.c);
      if (!isComposite(cell)) {
        cursor.slot = null;
        moveCursor(cursor.r + dir, cursor.c, { autoEnterSlot: false });
        return;
      }
      const slots = compositeSlots(cell);
      const idx = slots.indexOf(cursor.slot);
      const lastIdx = slots.length - 1;
      let nextIdx = -1;
      if (cell.type === 'fraction') {
        // num is "above" den in display: ↑ in den → num; ↓ in num → den.
        if (dir < 0) nextIdx = idx > 0 ? idx - 1 : -1;
        else nextIdx = idx < lastIdx ? idx + 1 : -1;
      } else if (cell.type === 'pow') {
        // exp is "above" base in display: ↑ in base → exp; ↓ in exp → base.
        if (dir < 0) nextIdx = idx === 0 ? 1 : -1;
        else nextIdx = idx === 1 ? 0 : -1;
      } else if (cell.type === 'nroot') {
        // index sits as a superscript on the √ (above the radicand line):
        // ↑ in radicand → index; ↓ in index → radicand.
        if (dir < 0) nextIdx = idx === 1 ? 0 : -1;
        else nextIdx = idx === 0 ? 1 : -1;
      }
      // sqrt/abs (single slot) always exit on ↑/↓.

      if (nextIdx === -1) {
        cursor.slot = null;
        moveCursor(cursor.r + dir, cursor.c, { autoEnterSlot: false });
      } else {
        cursor.slot = slots[nextIdx];
        repaintCell(cursor.r, cursor.c);
      }
      return;
    }
    moveCursor(cursor.r + dir, cursor.c);
  }

  function exitComposite(dir) {
    if (!cursor.slot) return;
    cursor.slot = null;
    if (dir === 0) {
      repaintCell(cursor.r, cursor.c);
      return;
    }
    // Skip past the FULL width of the composite — wide fractions occupy
    // multiple columns, and the cursor must land outside their span.
    const here = getCellAt(cursor.r, cursor.c);
    const w = here ? compositeWidth(here) : 1;
    const targetC = dir > 0 ? cursor.c + w : cursor.c - 1;
    if (targetC < 0 || targetC >= activeWorkBlock.cols) {
      repaintCell(cursor.r, cursor.c);
      return;
    }
    moveCursor(cursor.r, targetC, { autoEnterSlot: false });
  }

  function moveCursor(r, c, options) {
    if (!activeWorkBlock) return;
    const nr = clamp(r, 0, activeWorkBlock.rows - 1);
    // Lower bound is MARGIN_COLS — arrow-left at the start of the writable
    // area is a no-op rather than letting the cursor slip into the margin.
    const nc = clamp(c, MARGIN_COLS, activeWorkBlock.cols - 1);
    moveCursorTo(nr, nc, null, options);
  }

  // Reconcile cursor position + slot. Called for both navigation and
  // tap-to-position. autoEnterSlot defaults to true so tapping a composite
  // lands you inside its first slot — but exit paths pass false so the user
  // isn't immediately re-entered into an adjacent composite they were trying
  // to step past.
  function moveCursorTo(r, c, slot, options = {}) {
    if (!activeWorkBlock) return;
    const { autoEnterSlot = true } = options;
    let nr = clamp(r, 0, activeWorkBlock.rows - 1);
    // Same MARGIN_COLS clamp as moveCursor — every navigation path runs
    // through this function so doing it here covers arrow keys, tap-to-
    // position, slot-enter, and the post-edit cursor advance.
    let nc = clamp(c, MARGIN_COLS, activeWorkBlock.cols - 1);

    // If the target cell is occupied by a multi-cell composite anchored
    // elsewhere, redirect to the anchor — there's no rendered cell at the
    // requested position.
    const occupyingAnchor = findOccupyingAnchor(activeWorkBlock, nr, nc);
    if (occupyingAnchor) {
      nr = occupyingAnchor.r;
      nc = occupyingAnchor.c;
    }

    const target = getCellAt(nr, nc);

    let effectiveSlot = slot || null;
    if (effectiveSlot != null && !isComposite(target)) {
      effectiveSlot = null;
    } else if (effectiveSlot == null && autoEnterSlot && isComposite(target)) {
      effectiveSlot = compositeSlots(target)[0] || null;
    }

    if (nr === cursor.r && nc === cursor.c && effectiveSlot === cursor.slot) return;

    const prev = { r: cursor.r, c: cursor.c, slot: cursor.slot };
    cursor.r = nr;
    cursor.c = nc;
    cursor.slot = effectiveSlot;
    updateCursor(activeGrid, prev, cursor, getCellAt);
    if (prev.r !== nr) refreshActiveColsChip();
  }

  // Re-render just the active work block in place. Used when a fraction's
  // width changes (cells need to be added/removed to match the new span).
  function rerenderActiveGrid() {
    if (!activeGrid || !activeWorkBlock) return;
    const wrapper = activeGrid.parentElement; // .workblock
    if (!wrapper || !wrapper.parentElement) return;
    const parent = wrapper.parentElement;
    const workBlockCount = page.blocks.filter((b) => b.type === BLOCK.WORK).length;
    const canDeleteWork = workBlockCount > 1;
    const { wrapper: newWrapper, grid: newGrid } = renderWorkBlock(activeWorkBlock, {
      cursor,
      onCellTap: (r, c) => moveCursor(r, c),
      onLabelEdit: handleExerciseLabelEdit,
      onMovePart: (part, drow, dcol) =>
        movePartAndSave(activeWorkBlock, part, drow, dcol),
      onDelete: canDeleteWork ? (id) => removeBlock(id) : undefined
    });
    // Reattach drag + resize handles. Without this they vanish whenever a
    // fraction widens (or any other in-place rerender).
    attachBlockChrome(newWrapper, activeWorkBlock);
    applyBlockOffset(newWrapper, activeWorkBlock);
    parent.replaceChild(newWrapper, wrapper);
    activeGrid = newGrid;
  }

  function repaintCell(r, c) {
    const isCursorHere = cursor.r === r && cursor.c === c;
    updateCell(activeGrid, activeWorkBlock, r, c, isCursorHere ? cursor.slot : null);
  }

  // Strip the cell--cursor class (and any active-slot composite highlight)
  // from the currently active grid. Used when switching focus to a different
  // work block, so the previously active block doesn't keep showing a stale
  // blue highlight.
  function clearActiveCursorHighlight() {
    if (!activeGrid || !activeWorkBlock) return;
    const getCellAt = (rr, cc) => activeWorkBlock.cells[`${rr},${cc}`];
    updateCursor(activeGrid, cursor, null, getCellAt);
  }

  // ---------- undo history ----------
  // Page-level undo: snapshots the page's blocks, the cursor, and the id of
  // the active work block before each mutating action. The "↶ ביטול" button
  // pops the most recent snapshot and restores it. Strokes are NOT covered
  // here — the pen tools have their own dedicated undo for drawings.
  const undoStack = [];
  const MAX_UNDO = 80;
  const undoBtn = document.getElementById('undo-edit');

  function snapshotState() {
    return JSON.stringify({
      blocks: page.blocks,
      cursor: { r: cursor.r, c: cursor.c, slot: cursor.slot },
      activeBlockId: activeWorkBlock ? activeWorkBlock.id : null
    });
  }

  // Capture pre-mutation state. Dedup against the top of the stack so that
  // refused presses (no actual mutation) don't pile up identical snapshots
  // and force the kid to undo five times for one visible step.
  function pushUndo() {
    const snapshot = snapshotState();
    if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) {
      return;
    }
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    refreshUndoButton();
  }

  function refreshUndoButton() {
    if (!undoBtn) return;
    undoBtn.disabled = undoStack.length === 0;
  }

  async function undo() {
    if (undoStack.length === 0) return;
    // Drop any leading snapshots that match the current state — defensive in
    // case a snapshot was pushed and the mutator that followed turned out to
    // be a no-op. The first visible undo should always change something.
    while (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshotState()) {
      undoStack.pop();
    }
    if (undoStack.length === 0) {
      refreshUndoButton();
      return;
    }
    const restored = JSON.parse(undoStack.pop());
    page.blocks = restored.blocks;
    cursor.r = restored.cursor.r;
    cursor.c = restored.cursor.c;
    cursor.slot = restored.cursor.slot;
    if (restored.activeBlockId) {
      const found = page.blocks.find((b) => b.id === restored.activeBlockId);
      activeWorkBlock = found || null;
    } else {
      activeWorkBlock = null;
    }
    await savePage(page);
    await renderBlocks();
    refreshUndoButton();
  }

  if (undoBtn) {
    undoBtn.addEventListener('click', () => undo());
    refreshUndoButton();
  }

  // ---------- debounced save ----------

  let saveTimer = null;
  // Track all pending save promises so cleanup can await them and we never
  // lose a typed digit by tearing down the editor between debounce-fire
  // and the IDB transaction completing.
  const pendingPageSaves = new Set();

  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
    // Cell content changed — chip may need to flip amber, so refresh now
    // (cheap O(cells-on-row) scan, no DOM rerender).
    refreshActiveColsChip();
  }

  // Returns a Promise that resolves once any pending save has been awaited.
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      doSave(); // adds to pendingPageSaves
    }
    return Promise.allSettled([...pendingPageSaves]);
  }

  function doSave() {
    saveTimer = null;
    const p = (async () => {
      try {
        await savePage(page);
      } catch (err) {
        console.error('Save failed:', err);
        notifySaveError();
      }
    })();
    pendingPageSaves.add(p);
    p.finally(() => pendingPageSaves.delete(p));
  }

  // Flush in-flight saves whenever the OS is about to swap the tab out
  // or unload the page. Without these listeners a 300ms debounce window
  // mid-typing could lose the most recent characters if the kid rotates
  // the iPad, swipes to the home screen, or closes the PWA — iPadOS
  // pauses the WebKit JIT on `visibilitychange → hidden` and may not
  // resume before the page is torn down.
  function flushOnLifecycle() {
    // Best-effort: kick the debounced PAGE save AND nudge any in-flight
    // stroke saves. Persistence QA flagged that the original version
    // only touched flushSave() — a Pencil stroke just lifted before
    // unload would be lost because addStroke's IDB write hadn't
    // committed. We can't actually block the unload, so the awaited
    // promises mostly just give the queued transactions a chance to
    // settle before the JIT pauses.
    try { flushSave(); } catch (_) {}
    try {
      // Read the global tracker if present; pendingStrokeSaves is
      // declared inside the same closure (editor scope).
      if (typeof pendingStrokeSaves !== 'undefined') {
        Promise.allSettled([...pendingStrokeSaves]).catch(() => {});
      }
    } catch (_) {}
  }
  window.addEventListener('beforeunload', flushOnLifecycle, { signal: mountSignal });
  window.addEventListener('pagehide', flushOnLifecycle, { signal: mountSignal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnLifecycle();
  }, { signal: mountSignal });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
