// Drives the real Electron app with Playwright. Native dialogs are stubbed; files are real and re-read with the engine.
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PdfEngine, encryptPdf } from "../src/engine/engine.ts";
import { makeImagePdf, makeNoisyPng, makePng, makeTextPdf } from "./fixtures.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "test-output");
rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(OUT, { recursive: true });
const f = (name: string) => path.join(OUT, name);
const write = (name: string, bytes: Uint8Array) => { writeFileSync(f(name), bytes); return f(name); };

const samples = {
  doc: write("doc.pdf", makeTextPdf(["Alpha first line\nBravo second line\nCharlie third line", "Page two Alpha", "Page three", "Page four"])),
  locked: write("locked.pdf", encryptPdf(makeTextPdf(["Secret inside", "Second secret"]), "letmein", "owner")),
  restricted: write("restricted.pdf", encryptPdf(makeTextPdf(["Read only"]), "", "owner", true)),
  image: write("image.pdf", makeImagePdf(makePng(100, 100, [255, 0, 0]), [100, 100, 300, 300], "Caption")),
  big: write("big.pdf", makeImagePdf(makeNoisyPng(1400, 1400), [50, 50, 350, 350], "Readable text")),
  blue: write("blue.png", makePng(120, 60, [0, 0, 255])),
  green: write("green.png", makePng(60, 120, [0, 200, 0])),
  other: write("other.pdf", makeTextPdf(["Other one", "Other two"])),
};

const reopen = (file: string, password?: string) => {
  const e = new PdfEngine();
  const r = e.open(readFileSync(file), password);
  if (r.status !== "ok") throw new Error(`could not reopen ${file}`);
  return e;
};
const texts = (e: PdfEngine) => Array.from({ length: e.info().pageCount }, (_v, i) => e.pageText(i).trim());
function pixel(e: PdfEngine, page: number, x: number, y: number): number[] {
  const { width, pixels } = e.render(page, 1);
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  // Unpainted page areas are transparent; composite over white, as the viewer does.
  const a = pixels[i + 3] / 255;
  return [0, 1, 2].map((c) => Math.round(pixels[i + c] * a + 255 * (1 - a)));
}

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}

let app: ElectronApplication;
let page: Page;
let launches = 0;

async function launch(): Promise<void> {
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${f(`profile-${launches++}`)}`], cwd: ROOT });
  page = await app.firstWindow();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") failures.push(`console error: ${m.text()}`); });
  await page.waitForSelector("#btn-open");
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
}

/** Queues what the next native dialogs return. */
async function stub(kind: "open" | "save" | "folder", value: string | string[] | null): Promise<void> {
  await app.evaluate(({ dialog }, { kind, value }) => {
    if (kind === "save") dialog.showSaveDialog = async () => ({ canceled: value === null, filePath: (value as string) ?? "" });
    else dialog.showOpenDialog = async () => ({ canceled: value === null, filePaths: value === null ? [] : (Array.isArray(value) ? value : [value]) as string[] });
  }, { kind, value });
}

async function idle(): Promise<void> {
  await page.waitForTimeout(50);
  await page.waitForFunction(() => document.body.style.cursor === "");
  await page.waitForTimeout(30);
}

async function open(file: string): Promise<void> {
  await stub("open", file);
  await page.click("#btn-open");
  await page.waitForSelector('[data-testid="page-0"][data-rendered="true"]');
  await idle();
}

async function saveAs(name: string): Promise<string> {
  const target = f(name);
  await stub("save", target);
  await page.click("#btn-saveas");
  await idle();
  return target;
}

/** Screen position of a page-space point. */
async function at(index: number, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(`[data-testid="page-${index}"]`).boundingBox())!;
  const zoom = Number(await page.getAttribute("#zoom-select", "data-zoom"));
  return [box.x + x * zoom, box.y + y * zoom];
}

async function drag(index: number, a: [number, number], b: [number, number]): Promise<void> {
  const [x0, y0] = await at(index, ...a);
  const [x1, y1] = await at(index, ...b);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
  await idle();
}

async function clickAt(index: number, x: number, y: number): Promise<void> {
  const [px, py] = await at(index, x, y);
  await page.mouse.click(px, py);
}

const dialogClosed = () => page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#dialog")!.open);
/** The same path as clicking the window's X button. */
const closeWindow = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
const shot = (name: string) => page.screenshot({ path: f(`${name}.png`) });
const title = () => page.title();

async function section1(): Promise<void> {
  console.log("1. Open, password, view, zoom, thumbnails, search, save");
  await shot("01-empty");
  await stub("open", samples.locked);
  await page.click("#btn-open");
  await page.waitForSelector('[data-testid="password-input"]');
  check("password prompt appears", true);
  await page.fill('[data-testid="password-input"]', "wrong");
  await page.click('[data-testid="password-ok"]');
  await page.waitForSelector("text=That password is incorrect");
  check("wrong password is rejected with a message", true);
  await page.fill('[data-testid="password-input"]', "letmein");
  await page.press('[data-testid="password-input"]', "Enter");
  await page.waitForSelector('[data-testid="page-0"][data-rendered="true"]');
  check("right password opens the document", (await page.locator('[data-testid^="thumb-"]').count()) === 2);
  check("status shows protection", (await page.textContent("#status"))!.includes("Password protected"));

  await open(samples.doc);
  check("thumbnails: one per page", (await page.locator('[data-testid^="thumb-"]').count()) === 4);
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="thumb-0"] canvas');
    return !!c && c.width > 20;
  });
  check("thumbnail is drawn", true);
  await page.waitForTimeout(100);
  const pageHasInk = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="page-0"] canvas')!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] < 100) dark++;
    return dark;
  });
  check("page text is painted on the canvas", pageHasInk > 50, `dark=${pageHasInk}`);
  await shot("02-open");

  const widthAt = async () => (await page.locator('[data-testid="page-0"]').boundingBox())!.width;
  await page.selectOption("#zoom-select", "1");
  await idle();
  const w100 = await widthAt();
  check("zoom 100% is 612 wide", Math.abs(w100 - 612) < 1, String(w100));
  await page.click("#btn-zoomin");
  await idle();
  check("zoom in enlarges", (await widthAt()) > w100);
  await page.click("#btn-zoomout");
  await page.click("#btn-zoomout");
  await idle();
  check("zoom out shrinks", (await widthAt()) < w100);
  await page.selectOption("#zoom-select", "page");
  await idle();
  const box = (await page.locator('[data-testid="page-0"]').boundingBox())!;
  const view = (await page.locator("#viewer").boundingBox())!;
  check("fit page fits inside the viewer", box.height <= view.height);
  await page.selectOption("#zoom-select", "1");
  await idle();
  await page.locator("#viewer").hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await idle();
  check("Ctrl+wheel zooms", (await widthAt()) > w100);
  await page.selectOption("#zoom-select", "1");
  await idle();

  await page.keyboard.press("Control+f");
  await page.fill("#search-input", "alpha");
  await page.waitForFunction(() => document.getElementById("search-count")!.textContent === "1 of 2");
  check("search counts matches, ignoring case", true);
  check("search highlights on the page", (await page.locator(".hit").count()) >= 1);
  await page.press("#search-input", "Enter");
  await page.waitForFunction(() => document.getElementById("search-count")!.textContent === "2 of 2");
  check("search moves to the next match on page 2", (await page.inputValue("#page-input")) === "2");
  await shot("03-search");
  await page.fill("#search-input", "zzzz");
  await page.waitForFunction(() => document.getElementById("search-count")!.textContent === "No matches");
  check("search reports no matches", true);
  await page.click("#search-close");

  await page.click('[data-testid="thumb-2"]');
  check("clicking a thumbnail goes to that page", (await page.inputValue("#page-input")) === "3");
  await page.click('[data-testid="thumb-0"]');
  await idle();
  check("no unsaved marker before edits", !(await title()).startsWith("*"));
}

async function section2(): Promise<void> {
  console.log("2. Add text, image, signature, shapes, highlight, whiteout");
  await open(samples.doc);
  await page.selectOption("#zoom-select", "1");
  await idle();

  await page.click("#btn-tool-text");
  await clickAt(0, 300, 200);
  await page.waitForSelector('[data-testid="inline-edit"]');
  await page.keyboard.type("Added words");
  await page.keyboard.press("Control+Enter");
  await idle();
  check("adding text marks the document unsaved", (await title()).startsWith("*"));

  await stub("open", samples.blue);
  await page.click("#btn-tool-image");
  await page.waitForFunction(() => document.getElementById("btn-tool-image")!.getAttribute("aria-pressed") === "true");
  await drag(0, [300, 300], [420, 360]);

  await page.click("#btn-tool-signature");
  await page.waitForSelector("#sig-canvas");
  const sig = (await page.locator("#sig-canvas").boundingBox())!;
  await page.mouse.move(sig.x + 40, sig.y + 90);
  await page.mouse.down();
  await page.mouse.move(sig.x + 120, sig.y + 40, { steps: 5 });
  await page.mouse.move(sig.x + 200, sig.y + 120, { steps: 5 });
  await page.mouse.move(sig.x + 300, sig.y + 60, { steps: 5 });
  await page.mouse.up();
  await shot("04-signature-dialog");
  await page.click('[data-testid="sig-ok"]');
  await page.waitForFunction(() => document.getElementById("btn-tool-signature")!.getAttribute("aria-pressed") === "true");
  await drag(0, [60, 400], [260, 480]);

  for (const [tool, a, b] of [["rect", [60, 520], [160, 600]], ["ellipse", [200, 520], [300, 600]], ["line", [340, 520], [440, 600]], ["arrow", [460, 520], [560, 600]]] as const) {
    await page.click(`#btn-tool-${tool}`);
    await drag(0, a as unknown as [number, number], b as unknown as [number, number]);
  }

  await page.click("#btn-tool-highlight");
  await drag(0, [72, 63], [180, 63]);

  await page.click("#btn-tool-whiteout");
  await drag(0, [72, 100], [240, 125]);
  await shot("05-added-objects");

  const out = reopen(await saveAs("added.pdf"));
  const kinds = out.annotations(0).map((a) => a.kind).sort();
  check("all objects saved as real annotations", JSON.stringify(kinds) === JSON.stringify(["arrow", "ellipse", "highlight", "image", "image", "line", "rect", "text"]), kinds.join());
  check("added text content is saved", out.annotations(0).some((a) => a.text === "Added words"));
  const image = out.annotations(0).find((a) => a.kind === "image")!;
  const blue = pixel(out, 0, (image.rect[0] + image.rect[2]) / 2, (image.rect[1] + image.rect[3]) / 2);
  check("image is drawn where it was placed", blue[2] > 200 && blue[0] < 60, String(blue));
  const whiteoutHit = !/Charlie/.test(out.pageText(0)) || !/Bravo/.test(out.pageText(0));
  check("whiteout removed text from the file", whiteoutHit, out.pageText(0));
  const sign = out.annotations(0).filter((a) => a.kind === "image")[1];
  const signRect = sign.rect;
  const cornerBlank = pixel(out, 0, signRect[0] + 2, signRect[3] - 2);
  check("signature background is transparent", cornerBlank[0] > 240 && cornerBlank[1] > 240, String(cornerBlank));

  // Move, resize, retext, delete.
  await page.click("#btn-tool-select");
  const rect = out.annotations(0).find((a) => a.kind === "rect")!.rect;
  await clickAt(0, (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2);
  await page.waitForSelector('[data-testid="sel-box"]');
  check("clicking an object selects it", true);
  await drag(0, [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], [(rect[0] + rect[2]) / 2 + 200, (rect[1] + rect[3]) / 2 + 50]);
  const movedFile = reopen(await saveAs("moved.pdf"));
  const moved = movedFile.annotations(0).find((a) => a.kind === "rect")!.rect;
  check("dragging moves the object", Math.abs(moved[0] - rect[0] - 200) < 4 && Math.abs(moved[1] - rect[1] - 50) < 4, `${moved} from ${rect}`);
  await page.waitForSelector('[data-testid="sel-box"]');
  const [hx, hy] = await at(0, moved[2], moved[3]);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 40, hy + 30, { steps: 4 });
  await page.mouse.up();
  await idle();
  const resized = reopen(await saveAs("resized.pdf")).annotations(0).find((a) => a.kind === "rect")!.rect;
  check("dragging a handle resizes the object", Math.abs(resized[2] - moved[2] - 40) < 4 && Math.abs(resized[3] - moved[3] - 30) < 4, `${resized} from ${moved}`);

  const textAnnot = movedFile.annotations(0).find((a) => a.kind === "text")!;
  const tx = (textAnnot.rect[0] + textAnnot.rect[2]) / 2;
  const ty = (textAnnot.rect[1] + textAnnot.rect[3]) / 2;
  const [dx, dy] = await at(0, tx, ty);
  await page.mouse.dblclick(dx, dy);
  await page.waitForSelector('[data-testid="inline-edit"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Retyped words");
  await page.keyboard.press("Control+Enter");
  await idle();
  check("double-click retypes added text", reopen(await saveAs("retyped.pdf")).annotations(0).some((a) => a.text === "Retyped words"));

  await clickAt(0, (resized[0] + resized[2]) / 2, (resized[1] + resized[3]) / 2);
  await page.waitForSelector('[data-testid="sel-box"]');
  await page.keyboard.press("Delete");
  await idle();
  check("Delete key removes the selected object", !reopen(await saveAs("deleted.pdf")).annotations(0).some((a) => a.kind === "rect"));

  await page.click("#btn-flatten");
  await idle();
  check("flatten bakes objects into the page", reopen(await saveAs("flattened.pdf")).annotations(0).length === 0);

  // Signature variants: the drawn one was remembered, and a typed one can be made.
  await page.click("#btn-tool-signature");
  await page.waitForSelector('[data-testid="sig-tab-saved"]');
  check("the drawn signature is remembered", await page.isVisible('img[alt="Saved signature"]'));
  await page.click('[data-testid="sig-ok"]');
  await page.waitForFunction(() => document.getElementById("btn-tool-signature")!.getAttribute("aria-pressed") === "true");
  await clickAt(0, 330, 640);
  await idle();
  await page.click("#btn-tool-signature");
  await page.click('[data-testid="sig-tab-type"]');
  await page.fill('[data-testid="sig-typed"]', "Test Person");
  await page.click('[data-testid="sig-ok"]');
  await page.waitForFunction(() => document.getElementById("btn-tool-signature")!.getAttribute("aria-pressed") === "true");
  await clickAt(0, 330, 700);
  await idle();
  check("saved and typed signatures are placed", reopen(await saveAs("signatures.pdf")).annotations(0).filter((a) => a.kind === "image").length === 2);
  await shot("05b-signatures");

  // Characters the base fonts cannot draw must be refused with a message.
  await page.click("#btn-tool-text");
  await clickAt(0, 300, 650);
  await page.waitForSelector('[data-testid="inline-edit"]');
  await page.keyboard.insertText("नमस्ते");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".toast.error");
  check("unsupported characters show an error rather than vanishing", (await page.textContent(".toast.error"))!.includes("cannot be written"));
  await page.keyboard.press("Escape");
}

async function section3(): Promise<void> {
  console.log("3. Edit existing text; delete and replace images");
  await open(samples.doc);
  await page.selectOption("#zoom-select", "1");
  await idle();
  await page.click("#btn-tool-edittext");
  await page.waitForSelector('[data-testid="line-box"]');
  await shot("06-edit-text-mode");
  await page.locator('[data-testid="line-box"][title="Bravo second line"]').click();
  await page.waitForSelector('[data-testid="inline-edit"]');
  check("editor starts with the existing text", (await page.inputValue('[data-testid="inline-edit"]')) === "Bravo second line");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Bravo was edited");
  await shot("07-edit-text-active");
  await page.keyboard.press("Enter");
  await idle();
  const edited = reopen(await saveAs("edited.pdf")).pageText(0);
  check("replacement text is in the file", /Bravo was edited/.test(edited), edited);
  check("original text is gone from the file", !/Bravo second line/.test(edited), edited);
  check("neighbouring lines are untouched", /Alpha first line/.test(edited) && /Charlie third line/.test(edited), edited);

  await page.locator('[data-testid="line-box"][title="Alpha first line"]').click();
  await page.waitForSelector('[data-testid="inline-edit"]');
  await page.keyboard.type("Should not stay");
  await page.keyboard.press("Escape");
  await idle();
  check("Esc cancels an edit", /Alpha first line/.test(reopen(await saveAs("cancelled.pdf")).pageText(0)));

  await open(samples.image);
  await page.selectOption("#zoom-select", "1");
  await idle();
  await page.click("#btn-tool-editimage");
  await page.waitForSelector('[data-testid="img-box"]');
  await page.click('[data-testid="img-box"]');
  await page.waitForSelector('[data-testid="img-replace"]');
  await shot("08-edit-image");
  await stub("open", samples.blue);
  await page.click('[data-testid="img-replace"]');
  await idle();
  const replaced = reopen(await saveAs("image-replaced.pdf"));
  const p = pixel(replaced, 0, 200, 200);
  check("replacing an image swaps it in place", p[2] > 200 && p[0] < 60, String(p));
  check("replacing keeps a single image", replaced.pageImages(0).length === 1);
  await page.waitForSelector('[data-testid="img-box"]');
  await page.click('[data-testid="img-box"]');
  await page.click('[data-testid="img-delete"]');
  await idle();
  const removed = reopen(await saveAs("image-deleted.pdf"));
  check("deleting removes the image from the file", removed.pageImages(0).length === 0);
  check("deleting an image keeps the text", /Caption/.test(removed.pageText(0)));
}

async function section4(): Promise<void> {
  console.log("4. Delete, rotate, reorder, extract pages");
  await open(samples.doc);
  await page.click('[data-testid="thumb-1"]');
  await page.click("#btn-page-rotr");
  await idle();
  let e = reopen(await saveAs("rotated.pdf"));
  check("rotate changes page dimensions", Math.round(e.info().pages[1].width) === 792);
  await page.click("#btn-page-rotl");
  await idle();
  e = reopen(await saveAs("rotated-back.pdf"));
  check("rotate left undoes rotate right", Math.round(e.info().pages[1].width) === 612);

  await page.click('[data-testid="thumb-3"]');
  await page.click("#btn-page-up");
  await idle();
  check("move up reorders pages", texts(reopen(await saveAs("moved-up.pdf")))[2] === "Page four");

  await page.locator('[data-testid="thumb-0"]').scrollIntoViewIfNeeded();
  const from = (await page.locator('[data-testid="thumb-1"]').boundingBox())!;
  const to = (await page.locator('[data-testid="thumb-0"]').boundingBox())!;
  await page.click('[data-testid="thumb-1"]');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 12, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 10, { steps: 2 });
  await page.mouse.up();
  await idle();
  const dragged = texts(reopen(await saveAs("dragged.pdf")));
  check("dragging a thumbnail reorders pages", dragged[0] === "Page two Alpha", dragged.join("|"));
  await shot("09-pages");

  await page.click('[data-testid="thumb-0"]');
  await page.click('[data-testid="thumb-1"]', { modifiers: ["Control"] });
  await stub("save", f("extracted.pdf"));
  await page.click("#btn-page-extract");
  await idle();
  check("extract saves the selected pages", reopen(f("extracted.pdf")).info().pageCount === 2);

  await page.click("#btn-page-delete");
  await idle();
  check("delete removes the selected pages", reopen(await saveAs("page-deleted.pdf")).info().pageCount === 2);
  await page.click('[data-testid="thumb-0"]');
  await page.click('[data-testid="thumb-1"]', { modifiers: ["Shift"] });
  await page.click("#btn-page-delete");
  await page.waitForSelector(".toast.error:has-text('at least one page')");
  check("deleting every page is refused", (await page.locator('[data-testid^="thumb-"]').count()) === 2);
}

async function section5(): Promise<void> {
  console.log("5. Merge and split");
  await open(samples.doc);
  await page.click("#btn-merge");
  await stub("open", [samples.other, samples.locked]);
  await page.click('[data-testid="merge-add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-list"] li').length === 3);
  await stub("save", f("merged.pdf"));
  await page.click('[data-testid="merge-ok"]');
  await page.waitForSelector('[data-testid="password-input"]');
  await page.fill('[data-testid="password-input"]', "letmein");
  await page.click('[data-testid="password-ok"]');
  await dialogClosed();
  await idle();
  const merged = texts(reopen(f("merged.pdf")));
  check("merge combines all files in order, including an encrypted one", merged.length === 8 && merged[4] === "Other one" && merged[6] === "Secret inside", merged.join("|"));

  mkdirSync(f("split"), { recursive: true });
  await stub("folder", f("split"));
  await page.click("#btn-split");
  await page.click('[data-testid="split-ok"]');
  await dialogClosed();
  await idle();
  const single = readdirSync(f("split")).sort();
  check("split every page makes one file per page", single.length === 4 && reopen(path.join(f("split"), single[2])).pageText(0).trim() === "Page three", single.join());

  mkdirSync(f("split2"), { recursive: true });
  await stub("folder", f("split2"));
  await page.click("#btn-split");
  await page.click('[data-testid="split-mode-ranges"]');
  await page.fill('[data-testid="split-ranges"]', "9-12");
  await page.click('[data-testid="split-ok"]');
  await page.waitForSelector('[data-testid="dialog-error"]:not([hidden])');
  check("split rejects an invalid range", true);
  await page.fill('[data-testid="split-ranges"]', "1-2, 3-4");
  await page.click('[data-testid="split-ok"]');
  await dialogClosed();
  await idle();
  const parts = readdirSync(f("split2")).sort();
  check("split by ranges", parts.length === 2 && reopen(path.join(f("split2"), parts[1])).info().pageCount === 2, parts.join());
}

async function section6(): Promise<void> {
  console.log("6. Images to PDF and PDF to images");
  await page.click("#btn-img2pdf");
  await stub("open", [samples.blue, samples.green]);
  await page.click('[data-testid="img-add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-list"] li').length === 2);
  await page.selectOption('dialog select[aria-label="Page size"]', "a4");
  await stub("save", f("from-images.pdf"));
  await page.click('[data-testid="img-ok"]');
  await dialogClosed();
  await idle();
  const fromImages = reopen(f("from-images.pdf"));
  check("images become one page each", fromImages.info().pageCount === 2);
  check("page size is applied", Math.round(fromImages.info().pages[1].width) === 595);
  const mid = pixel(fromImages, 0, fromImages.info().pages[0].width / 2, fromImages.info().pages[0].height / 2);
  check("image content is on the page", mid[2] > 200, String(mid));

  await open(samples.doc);
  mkdirSync(f("png"), { recursive: true });
  await stub("folder", f("png"));
  await page.click("#btn-pdf2img");
  await page.fill('[data-testid="export-pages"]', "1,3");
  await page.selectOption('[data-testid="export-dpi"]', "96");
  await page.click('[data-testid="export-ok"]');
  await dialogClosed();
  await idle();
  const png = readdirSync(f("png")).sort();
  check("PNG export writes the chosen pages", png.length === 2 && png[1].includes("page3"), png.join());
  check("PNG file is a real PNG", readFileSync(path.join(f("png"), png[0]))[1] === 0x50);

  mkdirSync(f("jpg"), { recursive: true });
  await stub("folder", f("jpg"));
  await page.click("#btn-pdf2img");
  await page.selectOption('[data-testid="export-format"]', "jpeg");
  await page.click('[data-testid="export-ok"]');
  await dialogClosed();
  await idle();
  const jpg = readdirSync(f("jpg"));
  check("JPEG export writes every page by default", jpg.length === 4 && readFileSync(path.join(f("jpg"), jpg[0]))[0] === 0xff, jpg.join());
}

async function section7(): Promise<void> {
  console.log("7. Compress");
  await open(samples.big);
  const before = statSync(samples.big).size;
  await page.click("#btn-compress");
  await page.click('[data-testid="compress-screen"]');
  await page.click('[data-testid="compress-ok"]');
  await dialogClosed();
  await idle();
  check("compress reports its result", (await page.textContent("#status"))!.includes("smaller"));
  check("compress marks the document unsaved", (await title()).startsWith("*"));
  const out = await saveAs("compressed.pdf");
  const after = statSync(out).size;
  check("compressed file is much smaller", after < before * 0.25, `${before} -> ${after}`);
  check("compressed file keeps text", /Readable text/.test(reopen(out).pageText(0)));
  check("original file is unchanged on disk", statSync(samples.big).size === before);
  await shot("10-compressed");
}

async function section8(): Promise<void> {
  console.log("8. Undo, redo, unsaved changes warning");
  await open(samples.doc);
  check("undo is disabled on a fresh document", await page.isDisabled("#btn-undo"));
  await page.click('[data-testid="thumb-0"]');
  await page.click("#btn-page-delete");
  await idle();
  check("edit enables undo", await page.isEnabled("#btn-undo"));
  check("title marks unsaved", (await title()).startsWith("*"));
  await page.click("#btn-undo");
  await idle();
  check("undo restores the page", (await page.locator('[data-testid^="thumb-"]').count()) === 4);
  check("undo back to the opened state clears the marker", !(await title()).startsWith("*"));
  await page.keyboard.press("Control+y");
  await idle();
  check("Ctrl+Y redoes", (await page.locator('[data-testid^="thumb-"]').count()) === 3);
  await page.keyboard.press("Control+z");
  await idle();
  check("Ctrl+Z undoes", (await page.locator('[data-testid^="thumb-"]').count()) === 4);

  // Text edit and shape walk back together.
  await page.selectOption("#zoom-select", "1");
  await idle();
  await page.click("#btn-tool-rect");
  await drag(0, [100, 300], [200, 400]);
  check("a shape can be drawn after undoing, with messages on screen", await page.isEnabled("#btn-undo"));
  await page.click("#btn-tool-edittext");
  await page.waitForSelector('[data-testid="line-box"]');
  await page.locator('[data-testid="line-box"][title="Alpha first line"]').click();
  check("line editor opens after undoing", await page.isVisible('[data-testid="inline-edit"]'));
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Changed");
  await page.keyboard.press("Enter");
  await idle();
  await page.click("#btn-undo");
  await idle();
  await page.click("#btn-undo");
  await idle();
  const back = reopen(await saveAs("undo-walk.pdf"));
  check("undo walks back through mixed edits", /Alpha first line/.test(back.pageText(0)) && back.annotations(0).length === 0, back.pageText(0));

  // Opening another file while dirty asks first.
  await page.click("#btn-page-rotr").catch(() => {});
  await page.click('[data-testid="thumb-0"]');
  await page.click("#btn-page-rotr");
  await idle();
  await page.click("#btn-open");
  await page.waitForSelector("text=Unsaved changes");
  check("opening another file warns about unsaved changes", true);
  await shot("11-unsaved-warning");
  await page.click('#dialog button:has-text("Cancel")');
  await idle();
  check("cancel keeps the document open and unsaved", (await title()).startsWith("*"));

  const closeResult = (choice: number) => app.evaluate(({ dialog }, choice) => {
    const g = globalThis as unknown as { __asked: number };
    g.__asked = 0;
    dialog.showMessageBoxSync = (() => { g.__asked++; return choice; }) as never;
  }, choice);
  await closeResult(2);
  await closeWindow();
  await page.waitForTimeout(400);
  const asked = await app.evaluate(() => (globalThis as unknown as { __asked: number }).__asked);
  check("closing with unsaved changes warns", asked === 1, String(asked));
  check("choosing Cancel keeps the window open", !page.isClosed());

  // Save then close writes the file.
  const target = await saveAs("before-close.pdf");
  check("Save As clears the unsaved marker", !(await title()).startsWith("*"));
  await page.click('[data-testid="thumb-0"]');
  await page.click("#btn-page-rotr");
  await idle();
  const sizeBefore = readFileSync(target);
  await closeResult(0);
  const closed = app.waitForEvent("close");
  await closeWindow();
  await closed;
  check("Save on close writes the file and exits", !readFileSync(target).equals(sizeBefore));

  await launch();
  await open(samples.doc);
  await page.click('[data-testid="thumb-0"]');
  await page.click("#btn-page-delete");
  await idle();
  await closeResult(1);
  const closed2 = app.waitForEvent("close");
  await closeWindow();
  await closed2;
  check("Don't Save closes without writing", reopen(samples.doc).info().pageCount === 4);
}

async function sectionRestricted(): Promise<void> {
  console.log("Permissions");
  await launch();
  await stub("open", samples.restricted);
  await page.click("#btn-open");
  await page.waitForSelector('[data-testid="page-0"][data-rendered="true"]');
  await idle();
  check("a restricted PDF shows the read-only banner", await page.isVisible("#readonly"));
  check("edit tools are disabled", await page.isDisabled("#btn-tool-text"));
  await shot("12-restricted");
  await page.click("#unlock");
  await page.fill('[data-testid="password-input"]', "owner");
  await page.click('[data-testid="password-ok"]');
  await page.waitForSelector("#readonly", { state: "hidden" });
  check("owner password enables editing", await page.isEnabled("#btn-tool-text"));
}

/** A real unsaved-changes box would block forever with nobody to answer it, so end the process directly. */
async function forceQuit(): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function main(): Promise<void> {
  setTimeout(async () => {
    console.log(`\nWATCHDOG: gave up. ${passed} passed, failures so far: ${failures.join(" | ")}`);
    await shot("99-watchdog").catch(() => {});
    await forceQuit();
    process.exit(2);
  }, 280_000).unref();
  await launch();
  try {
    await section1();
    await section2();
    await section3();
    await section4();
    await section5();
    await section6();
    await section7();
    await section8();
    await sectionRestricted();
  } catch (err) {
    failures.push(`aborted: ${(err as Error).message}`);
    await shot("99-abort").catch(() => {});
  }
  await forceQuit();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

await main();
