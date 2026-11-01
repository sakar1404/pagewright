# Implementation plan

## Stack

| Part | Choice | Why |
|---|---|---|
| Shell | Electron | Native dialogs, real file saving, close warning; Windows-first and portable |
| PDF engine | MuPDF (WebAssembly) | One engine for parsing, decryption, rendering, redaction and saving |
| UI | TypeScript, no framework, built with Vite | Small, and the UI is mostly canvas and overlays |
| Threading | Engine in a Web Worker | Large files never freeze the window |
| Tests | `node:test` for the engine, Playwright driving the real Electron app | Checks both the PDF output and the UI |

## Architecture (mirrors the layers in the analysis)

```
electron/main.cjs      file dialogs, approved-path file IO, close prompt
electron/preload.cjs   narrow, typed bridge to the renderer
src/engine/engine.ts   UI-free PDF operations (runs in Node and in the worker)
src/engine/worker.ts   RPC wrapper around the engine
src/ui/*               viewer, thumbnails, tools, dialogs
tests/*                engine tests and end-to-end UI tests
```

## Key decisions

- **Undo/redo:** every edit stores a full snapshot of the PDF, capped by a memory
  budget. One mechanism covers all edits, including page operations.
- **Added objects are real PDF annotations** (FreeText, Stamp, Square, Circle,
  Line, Highlight), so they stay selectable, movable and resizable, even after
  saving and in other PDF viewers.
- **Whiteout removes content:** it deletes the text, image pixels and line art
  underneath before painting white. Covered text cannot be recovered by
  copy-paste.
- **Edit text:** the original line is removed from the page content and new text is
  drawn in its place at the same size and colour. It uses the PDF's own font when that
  font has every character, otherwise the closest standard font, and says so.
- **Replace image:** the old image is removed and the new one is placed with the
  same transform.
- **Encryption:** the password stays in memory, and saving keeps the original
  encryption. PDFs that restrict editing open read-only unless the owner password
  is given.

## Build order

1. Engine: open, render, search, save, password, snapshots
2. Engine: annotations, whiteout, text edit, image delete and replace
3. Engine: page operations, merge, split, images ↔ PDF, compress
4. Electron shell with safe file access
5. UI: viewer, zoom, thumbnails, search
6. UI: tools, signature dialog, inline text editor
7. UI: page panel, merge, split, convert, compress dialogs
8. Test everything; fix; document

## Test matrix

| # | Feature | Engine test | UI test |
|---|---|---|---|
| 1 | Open, password, view, zoom, thumbnails, search, save | yes | yes |
| 2 | Text, image, signature, shapes, highlight, whiteout | yes | yes |
| 3 | Edit text; delete and replace images | yes | yes |
| 4 | Delete, rotate, reorder, extract pages | yes | yes |
| 5 | Merge, split | yes | yes |
| 6 | Images → PDF, PDF → images | yes | yes |
| 7 | Compress | yes | yes |
| 8 | Undo, redo, unsaved warning | yes | yes |
