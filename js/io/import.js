// Worksheet upload: open a native file picker (camera or library), save the
// blob into IndexedDB, return a fresh WorksheetBlock with image dimensions.

import { putBlob } from '../db.js';
import { newWorksheetBlock } from '../page-model.js';

// Open a native file picker and resolve with the chosen File (or null if cancelled).
// On iPadOS Safari, providing capture="environment" hints the OS toward the camera.
export function pickImageFile({ capture = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);

    let resolved = false;
    const finish = (file) => {
      if (resolved) return;
      resolved = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    // Some browsers fire 'cancel' when the user dismisses the picker.
    input.addEventListener('cancel', () => finish(null));
    // Safari fallback: when window regains focus and no file was chosen, treat as cancel.
    const onFocus = () => {
      setTimeout(() => {
        if (!resolved) finish(null);
        window.removeEventListener('focus', onFocus);
      }, 300);
    };
    window.addEventListener('focus', onFocus);

    input.click();
  });
}

export function readImageDimensions(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const dims = { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image'));
    };
    img.src = url;
  });
}

function uid() {
  return `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Pick a file → save its blob → return a new WorksheetBlock. Null if cancelled.
export async function uploadWorksheet({ capture = false, fileOverride = null } = {}) {
  const file = fileOverride || (await pickImageFile({ capture }));
  if (!file) return null;
  const blobId = uid();
  await putBlob(blobId, file);
  let dims = { naturalWidth: 0, naturalHeight: 0 };
  try {
    dims = await readImageDimensions(file);
  } catch (_) {
    // Non-fatal — we can render without dimensions.
  }
  return newWorksheetBlock({ blobId, ...dims });
}
