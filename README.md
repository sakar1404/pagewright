# Pagewright

A desktop PDF editor for Windows, built with Electron, TypeScript and the MuPDF engine. It runs entirely on your computer: no account, no cloud, no network calls.

## Download

**[Download Pagewright for Windows (.exe, 120 MB)](https://github.com/sakar1404/pagewright/releases/download/v1.0.0/Pagewright-Setup-1.0.0.exe)**

Newer versions, if any, are on the [latest release](https://github.com/sakar1404/pagewright/releases/latest) page. Pagewright needs 64-bit Windows. The installer is not code-signed, so Windows may show "Windows protected your PC": choose **More info**, then **Run anyway**.

## Build from source

You need [Node.js](https://nodejs.org) 24 or newer (tested on 26.13).

```bash
npm install
```

```bash
npm start
```

To build an installer, which lands in `release/`:

```bash
npm run dist
```

The installer has no code-signing certificate, so Windows SmartScreen will warn when it runs, and the app uses Electron's default icon. Add a certificate and set `signAndEditExecutable` back to true in `package.json` to change that; building that way needs Windows Developer Mode.

To open a file directly, pass it as an argument: `npx electron . "C:\path\file.pdf"`.

## Features

| Area | What it does |
|---|---|
| View | Open (with password prompt), zoom, fit width or page, thumbnails, find, save, save as, drag a file in |
| Add | Text, image, signature (draw, type or image file, and it can be remembered), rectangle, ellipse, line, arrow, highlight, whiteout |
| Edit | Click a line of text to change it; replace or delete existing images |
| Added objects | Move, resize, retype or delete at any time, or flatten them into the page |
| Pages | Delete, rotate, reorder (drag or buttons), extract; Ctrl and Shift select several |
| Files | Merge (including password-protected inputs), split (every N pages or by ranges) |
| Convert | Images to PDF (PNG, JPEG, BMP, GIF, TIFF), PDF to PNG or JPEG at 72-600 dpi |
| Compress | Three presets; downsamples images, subsets fonts, removes unused data |
| Safety | Undo and redo for every edit, unsaved-changes warning, saves are verified and written atomically |

### Shortcuts

| Keys | Action |
|---|---|
| Ctrl+O, Ctrl+S, Ctrl+Shift+S | Open, Save, Save As |
| Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z) | Undo, Redo |
| Ctrl+F | Find |
| Ctrl+= , Ctrl+-, Ctrl+0, Ctrl+wheel | Zoom in, zoom out, fit width, zoom at pointer |
| V, T, H, W, E | Select, Text, Highlight, Whiteout, Edit text |
| Delete | Delete the selected object or image |
| Esc | Cancel or return to Select |
| In a text box | Ctrl+Enter commits added text; Enter commits an edited line |

## Good to know

- **Whiteout really removes content.** Text, image pixels and line art under the box are deleted from the file, not just covered. Undo works until you close the document; once it is saved and closed, the content is gone.
- **Passwords stay in memory only.** A password-protected PDF stays protected when saved. Extract and split write unprotected files, as do merges.
- **Restricted PDFs open read-only** until you enter the owner password.
- **Compress changes the open document, not the file**, until you save. You can undo it.

## Limitations

- **Text editing works one line at a time.** Other text does not reflow. A line too long for the page is squeezed horizontally to fit.
- **Fonts:** an edited line keeps the PDF's own font only if that font contains every character typed. Embedded fonts are often partial, and some formats cannot be reused, so the app then uses the closest of Helvetica, Times or Courier and tells you.
- **Non-Latin text** (Devanagari, CJK, Arabic and so on) can only be added where the PDF's own font already has those characters, and complex-script shaping is not applied. Added text boxes support Windows-1252 characters only. Anything else is refused with a message, never silently dropped.
- **Replacing or deleting an image** affects any image overlapping the centre of the one you clicked.
- **Scanned PDFs** have no text to edit; there is no OCR.
- **Not included:** form filling tools, digital (certificate) signatures, bookmarks editing, printing. A drawn signature is an image and has no cryptographic validity.
- **Undo history** keeps a full copy of the PDF per step, capped at 768 MB, after which the oldest steps are dropped.

## Project layout

```
electron/main.cjs      Window, file dialogs, approved-path file access, close warning
electron/preload.cjs   Narrow bridge between the page and the OS
src/engine/engine.ts   All PDF operations, with no UI (runs in Node and in a worker)
src/engine/worker.ts   Runs the engine off the UI thread
src/ui/main.ts         Viewer, thumbnails, tools, keyboard
src/ui/features.ts     Signature, merge, split, convert and compress dialogs
tests/engine.test.ts   Engine tests; each one re-opens the output and inspects it
tests/ui.e2e.ts        Drives the real app through every feature with Playwright
tests/realworld.ts     Stress check on your own PDFs (read-only)
```

## Tests

```bash
npm test
```

This runs the typecheck, the engine tests and the end-to-end UI tests. The UI tests open app windows for about a minute; screenshots and output files land in `test-output/`.

To check your own PDFs (they are only read):

```bash
node tests/realworld.ts out-folder "C:\path\one.pdf" "C:\path\two.pdf"
```

## Licence

Pagewright is licensed under the **GNU AGPL-3.0-or-later**; see [LICENSE](LICENSE). It uses [MuPDF](https://mupdf.com), which is licensed under AGPL-3.0. If you distribute a changed version or offer it as a network service, you must also release your complete source under the AGPL, or buy a commercial MuPDF licence from Artifex.

This project contains no Adobe code.
