// Renders a WorksheetBlock as a clean <img>.
// CRITICAL: this block has NO grid background. The grid is only in WorkBlocks.
// That's the whole reason this app exists — uploaded worksheets must render
// crisply, with no gridlines crossing the text.

import { getBlob } from '../db.js';

const urlCache = new Map(); // blobId -> objectURL

export async function renderWorksheetBlock(block, options = {}) {
  const wrapper = document.createElement('figure');
  wrapper.className = 'worksheet';
  wrapper.dataset.blockId = block.id;

  const img = document.createElement('img');
  img.className = 'worksheet__image';
  img.alt = '';
  img.draggable = false;

  let url = urlCache.get(block.blobId);
  if (!url) {
    const blob = await getBlob(block.blobId);
    if (blob) {
      url = URL.createObjectURL(blob);
      urlCache.set(block.blobId, url);
    }
  }
  if (url) {
    img.src = url;
  } else {
    img.alt = '— תמונת דף לא נמצאה —';
  }

  wrapper.appendChild(img);

  if (options.onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'worksheet__delete';
    del.textContent = '✕';
    del.title = 'הסר דף';
    del.setAttribute('aria-label', 'הסר דף');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onDelete(block.id);
    });
    wrapper.appendChild(del);
  }

  // Tap-to-collapse: in split view, tapping the worksheet shrinks it to a
  // thumbnail so the work block claims the freed space. Tap again to peek
  // back. The class is namespaced on the wrapper itself so split-mode CSS
  // picks it up; in non-split mode the class is harmless (the rules are
  // gated on `.editor--split`).
  wrapper.addEventListener('click', (e) => {
    if (e.target.closest('.worksheet__delete') || e.target.closest('.block__handle')) return;
    wrapper.classList.toggle('worksheet--collapsed');
  });

  return wrapper;
}

// Free object URLs when leaving the editor.
export function revokeWorksheetUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// Free a single blob's URL (call when a worksheet is deleted).
export function revokeBlobUrl(blobId) {
  const url = urlCache.get(blobId);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(blobId);
  }
}
