# MathApp

A local-first iPad math notebook for a Hebrew-speaking 8th-grader with a writing disability — built as a Progressive Web App. All UI text addresses the user in masculine Hebrew forms.

It replaces [ModMath](https://www.modmath.com/) with one critical fix: **uploaded worksheets render cleanly with no grid lines crossing the text**. The grid stays where it's needed (in the work area) and disappears where it isn't (under the worksheet image).

See `reference/modmath-bug-example.jpeg` for the original problem this app solves.

## Status

Phase 1 complete: PWA shell, IndexedDB storage, Hebrew RTL home screen, installable on iPad, runs offline.

Phases 2–6 (typed math grid, worksheet upload, Apple Pencil layer, composite math, export) are tracked in the build plan.

## Project layout

```
index.html              app shell, <html dir="rtl" lang="he">
manifest.webmanifest    PWA manifest (Hebrew, standalone display)
sw.js                   service worker, app-shell precache
css/app.css             layout, RTL, cards, buttons
js/main.js              bootstrap + router (home / editor)
js/db.js                IndexedDB: notebooks, pages, blobs, strokes
js/page-model.js        Page/Block/Cell schema
vendor/idb.js           vendored IndexedDB Promise wrapper
icons/                  180/192/512 PNG app icons
reference/              original ModMath bug screenshot
```

## Running locally on your computer

A PWA must be served over HTTP, not opened as a file. Use any static server:

```powershell
# From the repo root, with Python:
python -m http.server 8080

# Or with Node:
npx serve -l 8080 .
```

Then open `http://localhost:8080` in a browser.

## Installing on the iPad

After the app is hosted at a public HTTPS URL (GitHub Pages — instructions below):

1. Open the URL in **Safari** on the iPad (not Chrome — Chrome on iOS can't install PWAs).
2. Tap the Share button.
3. Tap **"Add to Home Screen"**.
4. Confirm the name (`MathApp`) and tap **Add**.
5. The icon appears on the home screen. Tap it once while online — the service worker installs.
6. After that, the app works fully offline (airplane mode, no Wi-Fi, anywhere).

## Deploying to GitHub Pages

1. Create a new public repo on GitHub (e.g. `mathapp`).
2. Add it as a remote and push:
   ```powershell
   git remote add origin https://github.com/<your-user>/mathapp.git
   git push -u origin main
   ```
3. In the repo's **Settings → Pages**, set Source to `main` / root, click Save.
4. After ~30 seconds, the app is live at `https://<your-user>.github.io/mathapp/`.
5. Open that URL in iPad Safari and follow the install steps above.

## Why a PWA (not a native iOS app)

- No Mac required (developable on Windows).
- No Apple Developer account or App Store approval needed.
- Free hosting via GitHub Pages.
- Works offline once installed.
- iPadOS 17+ exposes `pointerType === 'pen'` so Apple Pencil support works without the native API.
- Installed (home-screen) PWAs on iPadOS 17+ keep IndexedDB beyond the 7-day idle eviction that hits regular Safari tabs.

## Roadmap

- **Phase 1 ✅** — PWA shell, IndexedDB, Hebrew home screen, installable.
- **Phase 2** — Math keypad, grid cells (one digit per cell), column alignment.
- **Phase 3** — Worksheet upload (camera + library), no grid bleed.
- **Phase 4** — Apple Pencil drawing layer with palm rejection.
- **Phase 5** — Stacked fractions, exponents, square roots, variables, inequalities.
- **Phase 6** — JSON backup to Files, share-sheet/print, splash screens.
