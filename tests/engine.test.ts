// Engine tests: every assertion re-opens the output bytes and inspects the real PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { PdfEngine, encryptPdf, imagesToPdf, mergePdfs, unsupportedChars, NeedsPasswordError } from "../src/engine/engine.ts";
import { parseRanges } from "../src/ui/ranges.ts";
import { makeImagePdf, makePng, makeTextPdf, makeNoisyPng } from "./fixtures.ts";

function openEngine(bytes: Uint8Array): PdfEngine {
  const engine = new PdfEngine();
  const res = engine.open(bytes);
  assert.equal(res.status, "ok");
  return engine;
}

function reread(bytes: Uint8Array, password?: string): PdfEngine {
  const engine = new PdfEngine();
  const res = engine.open(bytes, password);
  assert.equal(res.status, "ok");
  return engine;
}

function pixel(engine: PdfEngine, page: number, x: number, y: number): number[] {
  const { width, pixels } = engine.render(page, 1);
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

function inkInRect(engine: PdfEngine, page: number, r: number[]): number {
  const { width, height, pixels } = engine.render(page, 1);
  let ink = 0;
  for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(height, r[3]); y++) {
    for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(width, r[2]); x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] > 40 && (pixels[i] < 200 || pixels[i + 1] < 200 || pixels[i + 2] < 200)) ink++;
    }
  }
  return ink;
}

// ---- 1. Open, password, view, search, save ----

test("opens, renders and reports pages", () => {
  const e = openEngine(makeTextPdf(["Page one", "Page two"]));
  const info = e.info();
  assert.equal(info.pageCount, 2);
  assert.equal(Math.round(info.pages[0].width), 612);
  const r = e.render(0, 2);
  assert.equal(r.width, 1224);
  assert.equal(r.pixels.length, r.width * r.height * 4);
});

test("rejects a file that is not a PDF with a clear error", () => {
  assert.throws(() => new PdfEngine().open(new TextEncoder().encode("hello, not a pdf")), /could not be opened/);
});

test("password: prompts, rejects the wrong one, accepts the right one", () => {
  const locked = encryptPdf(makeTextPdf(["Secret page"]), "user1", "owner1");
  const e = new PdfEngine();
  assert.deepEqual(e.open(locked), { status: "needs-password", wrongPassword: false });
  assert.deepEqual(e.open(locked, "nope"), { status: "needs-password", wrongPassword: true });
  const ok = e.open(locked, "user1");
  assert.equal(ok.status, "ok");
  assert.match(e.pageText(0), /Secret page/);
});

test("encrypted documents stay encrypted through edit, undo and save", () => {
  const locked = encryptPdf(makeTextPdf(["Secret page"]), "user1", "owner1");
  const e = reread(locked, "user1");
  e.addText(0, { rect: [50, 50, 300, 90], text: "Added", fontSize: 12, color: [0, 0, 0] });
  e.undo();
  e.redo();
  const saved = e.save();
  const again = new PdfEngine();
  assert.equal(again.open(saved).status, "needs-password");
  assert.equal(again.open(saved, "user1").status, "ok");
  assert.equal(again.annotations(0).length, 1);
});

test("a PDF that restricts editing is read-only until the owner password is given", () => {
  const locked = encryptPdf(makeTextPdf(["Restricted"]), "", "owner1", true);
  const e = new PdfEngine();
  const res = e.open(locked, "");
  assert.equal(res.status, "ok");
  assert.equal(e.info().canEdit, false);
  assert.throws(() => e.deletePages([0]), /restricts editing/);
  assert.equal(e.unlockEditing("wrong"), false);
  assert.equal(e.unlockEditing("owner1"), true);
  assert.equal(e.info().canEdit, true);
  e.addText(0, { rect: [50, 50, 300, 90], text: "ok", fontSize: 12, color: [0, 0, 0] });
});

test("search finds every hit with locations, across pages", () => {
  const e = openEngine(makeTextPdf(["alpha beta alpha", "gamma alpha", "nothing here"]));
  const hits = e.search("alpha");
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.page), [0, 0, 1]);
  assert.equal(e.search("zzz").length, 0);
  assert.equal(e.search("").length, 0);
});

test("save output reopens with the same content", () => {
  const e = openEngine(makeTextPdf(["Keep me"]));
  assert.match(reread(e.save()).pageText(0), /Keep me/);
});

// ---- 2. Add objects ----

test("add text is saved and visible", () => {
  const e = openEngine(makeTextPdf(["Base"]));
  e.addText(0, { rect: [100, 200, 400, 260], text: "Hello added", fontSize: 18, color: [1, 0, 0] });
  const out = reread(e.save());
  const a = out.annotations(0);
  assert.equal(a[0].kind, "text");
  assert.equal(a[0].text, "Hello added");
  assert.equal(a[0].fontSize, 18);
  assert.ok(inkInRect(out, 0, [100, 200, 400, 260]) > 30, "text should paint pixels");
});

test("add image and signature keep their placement", () => {
  const e = openEngine(makeTextPdf(["Base"]));
  e.addImage(0, [100, 300, 300, 400], makePng(40, 20, [0, 0, 255]));
  const out = reread(e.save());
  assert.equal(out.annotations(0)[0].kind, "image");
  const p = pixel(out, 0, 200, 350);
  assert.ok(p[2] > 200 && p[0] < 60, `expected blue, got ${p}`);
});

test("shapes: rectangle, ellipse, line and arrow", () => {
  const e = openEngine(makeTextPdf(["Base"]));
  e.addShape(0, { kind: "rect", rect: [50, 300, 150, 400], color: [1, 0, 0], fill: [0, 1, 0], width: 2 });
  e.addShape(0, { kind: "ellipse", rect: [200, 300, 300, 400], color: [0, 0, 1], width: 2 });
  e.addShape(0, { kind: "line", rect: [0, 0, 0, 0], line: [[50, 500], [300, 500]], color: [0, 0, 0], width: 3 });
  e.addShape(0, { kind: "arrow", rect: [0, 0, 0, 0], line: [[50, 550], [300, 550]], color: [0, 0, 0], width: 3 });
  const out = reread(e.save());
  assert.deepEqual(out.annotations(0).map((a) => a.kind), ["rect", "ellipse", "line", "arrow"]);
  const fill = pixel(out, 0, 100, 350);
  assert.ok(fill[1] > 200 && fill[0] < 60, `expected green fill, got ${fill}`);
  assert.ok(inkInRect(out, 0, [50, 495, 300, 505]) > 100, "line should paint");
});

test("highlight covers text and returns null on empty space", () => {
  const e = openEngine(makeTextPdf(["Highlight this sentence"]));
  const line = e.textLines(0)[0];
  const midY = (line.bbox[1] + line.bbox[3]) / 2;
  assert.ok(e.addHighlight(0, [line.bbox[0], midY], [line.bbox[2], midY], [1, 1, 0]));
  const out = reread(e.save());
  assert.equal(out.annotations(0)[0].kind, "highlight");
  const p = pixel(out, 0, line.bbox[0] + 1, line.bbox[1] + 1);
  assert.ok(p[0] > 240 && p[1] > 240 && p[2] < 180, `expected clear yellow, not a muddy tint: ${p}`);
  const blank = openEngine(makeTextPdf(["Hi"]));
  assert.equal(blank.addHighlight(0, [300, 700], [400, 720], [1, 1, 0]), null);
  assert.equal(blank.info().dirty, false);
});

test("whiteout removes text permanently, not only visually", () => {
  const e = openEngine(makeTextPdf(["Confidential number 12345"]));
  const line = e.textLines(0)[0];
  e.whiteout(0, [line.bbox[0] - 2, line.bbox[1] - 2, line.bbox[2] + 2, line.bbox[3] + 2]);
  const out = reread(e.save());
  assert.doesNotMatch(out.pageText(0), /12345/);
  assert.equal(inkInRect(out, 0, line.bbox), 0);
});

test("whiteout blanks image pixels under it only", () => {
  const e = openEngine(makeImagePdf(makePng(100, 100, [255, 0, 0]), [100, 100, 300, 300]));
  e.whiteout(0, [150, 150, 250, 250]);
  const out = reread(e.save());
  const under = pixel(out, 0, 200, 200);
  assert.ok(under[0] > 240 && under[1] > 240 && under[2] > 240, `expected white, got ${under}`);
  const beside = pixel(out, 0, 120, 120);
  assert.ok(beside[0] > 200 && beside[1] < 60, `expected red remains, got ${beside}`);
});

test("objects can be moved, retexted and deleted", () => {
  const e = openEngine(makeTextPdf(["Base"]));
  e.addText(0, { rect: [100, 100, 300, 140], text: "Movable", fontSize: 14, color: [0, 0, 0] });
  let a = e.annotations(0)[0];
  e.moveAnnotation(0, a.id, [200, 300, 400, 340]);
  a = e.annotations(0)[0];
  assert.ok(Math.abs(a.rect[0] - 200) < 2 && Math.abs(a.rect[1] - 300) < 2, `moved rect ${a.rect}`);
  e.updateAnnotationText(0, a.id, "Changed");
  assert.equal(e.annotations(0)[0].text, "Changed");
  e.deleteAnnotation(0, a.id);
  assert.equal(e.annotations(0).length, 0);
});

test("flatten bakes annotations into content", () => {
  const e = openEngine(makeTextPdf(["Base"]));
  e.addShape(0, { kind: "rect", rect: [50, 300, 150, 400], color: [1, 0, 0], fill: [0, 1, 0], width: 2 });
  e.flatten();
  const out = reread(e.save());
  assert.equal(out.annotations(0).length, 0);
  const fill = pixel(out, 0, 100, 350);
  assert.ok(fill[1] > 200 && fill[0] < 60);
});

test("characters outside the standard fonts are refused, not dropped", () => {
  assert.deepEqual(unsupportedChars("Café €5 – ok"), []);
  assert.deepEqual(unsupportedChars("नमस्ते".slice(0, 1)), ["न"]);
  const e = openEngine(makeTextPdf(["Base"]));
  assert.throws(() => e.addText(0, { rect: [50, 50, 300, 90], text: "日本", fontSize: 12, color: [0, 0, 0] }), /cannot be written/);
  assert.equal(e.info().dirty, false);
});

// ---- 3. Edit existing content ----

test("edit text: old words are gone, new words are real text in the same place", () => {
  const e = openEngine(makeTextPdf(["The quick brown fox", "second page"]));
  const lines = e.textLines(0);
  const line = lines.find((l) => l.text.includes("quick"))!;
  e.replaceTextLine(0, line.bbox, line, "The slow red fox");
  const out = reread(e.save());
  const text = out.pageText(0);
  assert.match(text, /The slow red fox/);
  assert.doesNotMatch(text, /quick/);
  const after = out.textLines(0).find((l) => l.text.includes("slow"))!;
  assert.ok(Math.abs(after.origin[0] - line.origin[0]) < 1 && Math.abs(after.origin[1] - line.origin[1]) < 1, "same position");
  assert.ok(Math.abs(after.size - line.size) < 0.5, "same size");
  assert.match(out.pageText(1), /second page/);
});

test("edit text leaves neighbouring lines intact", () => {
  const e = openEngine(makeTextPdf(["Line alpha\nLine bravo\nLine charlie"]));
  const lines = e.textLines(0);
  assert.equal(lines.length, 3);
  e.replaceTextLine(0, lines[1].bbox, lines[1], "Line BRAVO");
  const text = reread(e.save()).pageText(0);
  assert.match(text, /Line alpha/);
  assert.match(text, /Line BRAVO/);
  assert.match(text, /Line charlie/);
  assert.doesNotMatch(text, /Line bravo/);
});

test("edit text works on a rotated page", () => {
  const e = openEngine(makeTextPdf(["Rotated words"]));
  e.rotatePages([0], 90);
  const line = e.textLines(0)[0];
  e.replaceTextLine(0, line.bbox, line, "Changed words");
  assert.match(reread(e.save()).pageText(0), /Changed words/);
  assert.doesNotMatch(reread(e.save()).pageText(0), /Rotated/);
});

test("delete and replace an existing image", () => {
  const source = makeImagePdf(makePng(50, 50, [255, 0, 0]), [100, 100, 300, 300]);
  const del = openEngine(source);
  assert.equal(del.pageImages(0).length, 1);
  assert.equal(Math.round(del.pageImages(0)[0].bbox[0]), 100);
  del.deleteImage(0, 0);
  const deleted = reread(del.save());
  assert.equal(deleted.pageImages(0).length, 0);
  assert.equal(inkInRect(deleted, 0, [100, 100, 300, 300]), 0);

  const rep = openEngine(source);
  rep.replaceImage(0, 0, makePng(50, 50, [0, 0, 255]));
  const replaced = reread(rep.save());
  const imgs = replaced.pageImages(0);
  assert.equal(imgs.length, 1);
  assert.equal(Math.round(imgs[0].bbox[0]), 100);
  assert.equal(Math.round(imgs[0].bbox[3]), 300);
  const p = pixel(replaced, 0, 200, 200);
  assert.ok(p[2] > 200 && p[0] < 60, `expected blue, got ${p}`);
});

// ---- 4. Page operations ----

function pageWords(e: PdfEngine): string[] {
  return Array.from({ length: e.info().pageCount }, (_, i) => e.pageText(i).trim());
}

test("delete pages; refuses to delete all of them", () => {
  const e = openEngine(makeTextPdf(["A", "B", "C"]));
  e.deletePages([1]);
  assert.deepEqual(pageWords(reread(e.save())), ["A", "C"]);
  assert.throws(() => e.deletePages([0, 1]), /at least one page/);
  assert.equal(e.info().pageCount, 2);
});

test("rotate pages accumulates and swaps dimensions", () => {
  const e = openEngine(makeTextPdf(["A", "B"]));
  e.rotatePages([0], 90);
  let out = reread(e.save()).info();
  assert.equal(Math.round(out.pages[0].width), 792);
  assert.equal(Math.round(out.pages[1].width), 612);
  e.rotatePages([0], 90);
  out = reread(e.save()).info();
  assert.equal(Math.round(out.pages[0].width), 612);
  e.rotatePages([0], -90);
  e.rotatePages([0], 180);
  assert.equal(Math.round(reread(e.save()).info().pages[0].width), 792);
});

test("reorder pages; rejects an invalid order", () => {
  const e = openEngine(makeTextPdf(["A", "B", "C"]));
  e.reorderPages([2, 0, 1]);
  assert.deepEqual(pageWords(reread(e.save())), ["C", "A", "B"]);
  assert.throws(() => e.reorderPages([0, 0, 1]), /every page once/);
});

test("extract pages leaves the open document unchanged", () => {
  const e = openEngine(makeTextPdf(["A", "B", "C"]));
  assert.deepEqual(pageWords(reread(e.extractPages([2, 0]))), ["C", "A"]);
  assert.equal(e.info().pageCount, 3);
  assert.equal(e.info().dirty, false);
});

test("extract from an encrypted PDF writes an unencrypted file", () => {
  const e = reread(encryptPdf(makeTextPdf(["A", "B"]), "u", "o"), "u");
  assert.deepEqual(pageWords(reread(e.extractPages([1]))), ["B"]);
});

test("annotations survive page operations", () => {
  const e = openEngine(makeTextPdf(["A", "B"]));
  e.addText(1, { rect: [50, 50, 300, 90], text: "On B", fontSize: 12, color: [0, 0, 0] });
  e.reorderPages([1, 0]);
  const out = reread(e.save());
  assert.equal(out.annotations(0)[0].text, "On B");
  assert.equal(out.annotations(1).length, 0);
});

// ---- 5. Merge and split ----

test("merge keeps order, and page content from every file", () => {
  const merged = mergePdfs([{ data: makeTextPdf(["A", "B"]) }, { data: makeTextPdf(["C"]) }]);
  assert.deepEqual(pageWords(reread(merged)), ["A", "B", "C"]);
});

test("merge handles encrypted input with its password", () => {
  const locked = encryptPdf(makeTextPdf(["S"]), "pw", "own");
  assert.throws(() => mergePdfs([{ data: locked }]), NeedsPasswordError);
  assert.deepEqual(pageWords(reread(mergePdfs([{ data: locked, password: "pw" }]))), ["S"]);
});

test("append a PDF to the open document is undoable", () => {
  const e = openEngine(makeTextPdf(["A"]));
  e.appendPdf(makeTextPdf(["B", "C"]));
  assert.deepEqual(pageWords(e), ["A", "B", "C"]);
  e.undo();
  assert.deepEqual(pageWords(e), ["A"]);
});

test("split by ranges produces separate correct files", () => {
  const e = openEngine(makeTextPdf(["A", "B", "C", "D"]));
  const parts = e.split([[0, 0], [1, 2], [3, 3]]);
  assert.deepEqual(parts.map((p) => pageWords(reread(p))), [["A"], ["B", "C"], ["D"]]);
});

// ---- 6. Convert ----

test("images to PDF: one page per image, sized as requested", () => {
  const png = makePng(200, 100, [255, 0, 0]);
  const fit = reread(imagesToPdf([png, makePng(100, 200, [0, 255, 0])], { pageSize: "a4", margin: 20 }));
  assert.equal(fit.info().pageCount, 2);
  assert.equal(Math.round(fit.info().pages[0].width), 842, "landscape image gets a landscape page");
  assert.equal(Math.round(fit.info().pages[1].width), 595);
  const natural = reread(imagesToPdf([png], { pageSize: "image", margin: 0 }));
  assert.equal(Math.round(natural.info().pages[0].width), 150, "200px at 96 dpi");
  const p = pixel(natural, 0, 75, 37);
  assert.ok(p[0] > 200 && p[1] < 60, `expected red, got ${p}`);
  assert.throws(() => imagesToPdf([], { pageSize: "a4", margin: 0 }), /at least one/);
  assert.throws(() => imagesToPdf([new Uint8Array([1, 2, 3])], { pageSize: "a4", margin: 0 }), /not supported/);
});

test("PDF to images: PNG and JPEG at the requested resolution", () => {
  const e = openEngine(makeTextPdf(["Picture"]));
  const png = e.pageToImage(0, 144, "png");
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const im = new mupdf.Image(png);
  assert.equal(im.getWidth(), 1224);
  const jpg = e.pageToImage(0, 72, "jpeg", 80);
  assert.deepEqual([...jpg.slice(0, 2)], [0xff, 0xd8]);
  assert.equal(new mupdf.Image(jpg).getHeight(), 792);
});

// ---- 7. Compress ----

test("compress reduces size, keeps text and is undoable", () => {
  const big = makeImagePdf(makeNoisyPng(1600, 1600), [50, 50, 350, 350], "Readable text stays");
  const e = openEngine(big);
  const { result } = e.compress(100, 50);
  assert.ok(result.imagesRewritten >= 1, "image was rewritten");
  assert.ok(result.after < result.before * 0.5, `${result.before} -> ${result.after}`);
  const out = reread(e.save());
  assert.match(out.pageText(0), /Readable text stays/);
  assert.equal(out.pageImages(0).length, 1);
  assert.ok(out.pageImages(0)[0].width < 1600, "image downsampled");
  assert.equal(Math.round(out.pageImages(0)[0].bbox[2]), 350, "placement unchanged");
  e.undo();
  assert.equal(e.pageImages(0)[0].width, 1600);
});

test("compress does not enlarge a small already-optimal file", () => {
  const e = openEngine(makeTextPdf(["Tiny"]));
  const { result } = e.compress(150, 70);
  assert.ok(result.after <= result.before * 1.05, `${result.before} -> ${result.after}`);
});

// ---- 8. Undo, redo, dirty state ----

test("undo and redo restore each state, and the dirty flag tracks saves", () => {
  const e = openEngine(makeTextPdf(["A", "B"]));
  assert.equal(e.info().dirty, false);
  e.deletePages([0]);
  assert.equal(e.info().dirty, true);
  assert.equal(e.info().pageCount, 1);
  e.undo();
  assert.equal(e.info().pageCount, 2);
  assert.equal(e.info().dirty, false, "back at the opened state");
  e.redo();
  assert.equal(e.info().pageCount, 1);
  assert.equal(e.info().dirty, true);
  e.markSaved();
  assert.equal(e.info().dirty, false);
  e.undo();
  assert.equal(e.info().dirty, true, "undo past a save is a change");
  e.redo();
  assert.equal(e.info().dirty, false, "redo back to the saved state");
});

test("a new edit clears the redo stack", () => {
  const e = openEngine(makeTextPdf(["A", "B", "C"]));
  e.deletePages([0]);
  e.undo();
  e.rotatePages([0], 90);
  assert.equal(e.info().canRedo, false);
});

test("a failed edit leaves the document and history untouched", () => {
  const e = openEngine(makeTextPdf(["A"]));
  assert.throws(() => e.addImage(0, [0, 0, 10, 10], new Uint8Array([9, 9, 9])), /not supported/);
  assert.equal(e.info().canUndo, false);
  assert.equal(e.info().dirty, false);
  assert.match(e.pageText(0), /A/);
});

test("many undo levels walk back through mixed operations", () => {
  const e = openEngine(makeTextPdf(["A", "B"]));
  e.addText(0, { rect: [50, 50, 300, 90], text: "t", fontSize: 12, color: [0, 0, 0] });
  e.rotatePages([1], 90);
  const line = e.textLines(0)[0];
  e.replaceTextLine(0, line.bbox, line, "Z");
  e.reorderPages([1, 0]);
  for (let i = 0; i < 4; i++) e.undo();
  assert.equal(e.info().canUndo, false);
  assert.equal(e.annotations(0).length, 0);
  assert.equal(e.pageText(0).trim(), "A");
  assert.equal(Math.round(e.info().pages[1].width), 612);
  for (let i = 0; i < 4; i++) e.redo();
  assert.equal(e.pageText(1).trim().endsWith("Z"), true);
  assert.equal(Math.round(e.info().pages[0].width), 792);
});

// ---- Coverage for risky paths found while designing the UI ----

test("edit text keeps Windows-1252 characters intact", () => {
  const e = openEngine(makeTextPdf(["Plain line"]));
  const line = e.textLines(0)[0];
  e.replaceTextLine(0, line.bbox, line, "Caf\u00e9 \u20ac5 \u2013 \u201cok\u201d");
  assert.match(reread(e.save()).pageText(0), /Caf\u00e9 \u20ac5 \u2013 \u201cok\u201d/);
});

test("clearing a line deletes it", () => {
  const e = openEngine(makeTextPdf(["Gone\nStays"]));
  const line = e.textLines(0)[0];
  e.replaceTextLine(0, line.bbox, line, "   ");
  const text = reread(e.save()).pageText(0);
  assert.doesNotMatch(text, /Gone/);
  assert.match(text, /Stays/);
});

test("edited text on a rotated page lands where the old line was", () => {
  const e = openEngine(makeTextPdf(["Rotated words"]));
  e.rotatePages([0], 90);
  const old = e.textLines(0)[0];
  e.replaceTextLine(0, old.bbox, old, "Rotated WORDS");
  const now = reread(e.save()).textLines(0)[0];
  assert.ok(Math.abs(now.origin[0] - old.origin[0]) < 1.5 && Math.abs(now.origin[1] - old.origin[1]) < 1.5, `${now.origin} vs ${old.origin}`);
  assert.ok(Math.abs(now.dir[0] - old.dir[0]) < 0.01 && Math.abs(now.dir[1] - old.dir[1]) < 0.01, "same direction");
});

test("objects placed on a rotated page appear where they were placed", () => {
  const e = openEngine(makeTextPdf(["Base"]));
  e.rotatePages([0], 90);
  e.addShape(0, { kind: "rect", rect: [100, 100, 200, 200], color: [1, 0, 0], fill: [0, 1, 0], width: 1 });
  const p = pixel(reread(e.save()), 0, 150, 150);
  assert.ok(p[1] > 200 && p[0] < 60, `expected green, got ${p}`);
});

test("whiteout and image replace work on a rotated page", () => {
  const e = openEngine(makeImagePdf(makePng(50, 50, [255, 0, 0]), [100, 100, 300, 300]));
  e.rotatePages([0], 90);
  const before = e.pageImages(0)[0].bbox;
  e.replaceImage(0, 0, makePng(50, 50, [0, 0, 255]));
  const after = reread(e.save());
  const box = after.pageImages(0)[0].bbox;
  before.forEach((v, i) => assert.ok(Math.abs(v - box[i]) < 1, `bbox ${box} vs ${before}`));
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  assert.ok(pixel(after, 0, cx, cy)[2] > 200);
  e.whiteout(0, [cx - 20, cy - 20, cx + 20, cy + 20]);
  const blank = pixel(reread(e.save()), 0, cx, cy);
  assert.ok(blank[0] > 240 && blank[1] > 240 && blank[2] > 240, `expected white, got ${blank}`);
});

test("redaction-based edits keep other annotations on the page", () => {
  const e = openEngine(makeTextPdf(["First line\nSecond line"]));
  e.addShape(0, { kind: "rect", rect: [300, 300, 400, 400], color: [1, 0, 0], width: 2 });
  e.addText(0, { rect: [300, 450, 500, 500], text: "Keep", fontSize: 12, color: [0, 0, 0] });
  const line = e.textLines(0)[0];
  e.replaceTextLine(0, line.bbox, line, "Edited");
  e.whiteout(0, [60, 100, 200, 120]);
  assert.equal(reread(e.save()).annotations(0).length, 2);
});

test("moving a line and a highlight shifts them by the same offset", () => {
  const e = openEngine(makeTextPdf(["Highlight target"]));
  e.addShape(0, { kind: "line", rect: [0, 0, 0, 0], line: [[50, 300], [200, 300]], color: [0, 0, 0], width: 2 });
  const l = e.textLines(0)[0];
  const y = (l.bbox[1] + l.bbox[3]) / 2;
  e.addHighlight(0, [l.bbox[0], y], [l.bbox[2], y], [1, 1, 0]);
  const [line, hl] = e.annotations(0);
  e.moveAnnotation(0, line.id, line.rect, [[60, 320], [210, 320]]);
  const r = hl.rect;
  e.moveAnnotation(0, hl.id, [r[0] + 10, r[1] + 100, r[2] + 10, r[3] + 100]);
  const [movedLine, movedHl] = reread(e.save()).annotations(0);
  assert.deepEqual(movedLine.line, [[60, 320], [210, 320]]);
  assert.ok(Math.abs(movedHl.rect[1] - (r[1] + 100)) < 2, `${movedHl.rect} from ${r}`);
});

test("saveVerified returns bytes that reopen", () => {
  const e = reread(encryptPdf(makeTextPdf(["A", "B"]), "u", "o"), "u");
  assert.equal(reread(e.saveVerified(), "u").info().pageCount, 2);
});

test("page ranges parse strictly", () => {
  assert.deepEqual(parseRanges("1-2, 4,6-7", 8), [[0, 1], [3, 3], [5, 6]]);
  assert.deepEqual(parseRanges(" 3 ", 3), [[2, 2]]);
  for (const bad of ["", "0", "9", "3-1", "a", "1-", "1,,2"]) assert.throws(() => parseRanges(bad, 8), /page/i, bad);
});

test("object ids stay valid after saving", () => {
  const e = openEngine(makeTextPdf(["A", "B"]));
  e.addShape(0, { kind: "rect", rect: [50, 300, 150, 400], color: [1, 0, 0], width: 2 });
  e.deletePages([1]);
  const before = e.annotations(0)[0];
  const saved = e.save();
  assert.deepEqual(e.annotations(0)[0], before, "saving must not disturb the open document");
  e.moveAnnotation(0, before.id, [100, 300, 200, 400]);
  assert.ok(Math.abs(e.annotations(0)[0].rect[0] - 100) < 3);
  assert.equal(reread(saved).info().pageCount, 1);
});

test("saving does not create undo steps or change dirty state", () => {
  const e = openEngine(makeTextPdf(["A"]));
  e.save();
  assert.equal(e.info().canUndo, false);
  assert.equal(e.info().dirty, false);
});

test("a long replacement line is squeezed to stay on the page", () => {
  const e = openEngine(makeTextPdf(["Short"]));
  const line = e.textLines(0)[0];
  e.replaceTextLine(0, line.bbox, line, "A very long replacement sentence that would normally run far beyond the right edge of a Letter page");
  const after = reread(e.save()).textLines(0)[0];
  assert.ok(after.bbox[2] <= 612, `right edge ${after.bbox[2]}`);
  assert.match(after.text, /right edge of a Letter page/);
});

test("edit reuses the original font and reports when it cannot", () => {
  const e = openEngine(makeTextPdf(["Plain line"]));
  const line = e.textLines(0)[0];
  const info = e.replaceTextLine(0, line.bbox, line, "Plain words");
  assert.equal(info.fontFallback, false);
  assert.equal(reread(e.save()).textLines(0)[0].font.family, "Helvetica");
});

test("a line starting with invisible spaces is anchored to its first visible character", () => {
  const plain = openEngine(makeTextPdf(["Indented"])).textLines(0)[0];
  const e = openEngine(makeTextPdf(["     Indented"]));
  const line = e.textLines(0)[0];
  assert.equal(line.text, "Indented");
  assert.ok(line.origin[0] > plain.origin[0] + 10, `origin ${line.origin[0]} vs ${plain.origin[0]}`);
  e.replaceTextLine(0, line.bbox, line, "Changed");
  const after = reread(e.save()).textLines(0).find((l) => l.text === "Changed")!;
  assert.ok(Math.abs(after.origin[0] - line.origin[0]) < 1, `${after.origin[0]} vs ${line.origin[0]}`);
});
