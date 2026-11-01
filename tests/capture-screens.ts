// Captures every screen of the real app into design-handoff/screens, for use as design references.
import { _electron as electron } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { encryptPdf } from "../src/engine/engine.ts";
import { makePng, makeTextPdf } from "./fixtures.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHOTS = path.join(ROOT, "design-handoff", "screens");
const WORK = path.join(ROOT, "test-output", "capture");
rmSync(SHOTS, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });
const work = (name: string, bytes: Uint8Array) => {
  const file = path.join(WORK, name);
  writeFileSync(file, bytes);
  return file;
};

/** A four-page sample with headings, body text and a picture. */
function samplePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const regular = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  const bold = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"), "Latin");
  const image = doc.addImage(new mupdf.Image(makePng(320, 200, [120, 150, 200])));
  const body = (lines: string[], top: number) => lines.map((l, i) => `BT /F1 12 Tf 72 ${top - i * 20} Td (${l}) Tj ET`).join("\n");
  const pages = [
    `BT /F2 24 Tf 72 710 Td (Sample document) Tj ET\n${body(["This page shows how the editor looks while you work.", "These words can be clicked and changed in place.", "Added objects stay movable until they are flattened."], 670)}\nq 240 0 0 150 72 440 cm /Im0 Do Q\n${body(["A picture sits above this line and can be replaced or deleted."], 415)}`,
    `BT /F2 18 Tf 72 720 Td (Second page) Tj ET\n${body(["Text on the second page.", "Search finds matches on every page."], 690)}`,
    `BT /F2 18 Tf 72 720 Td (Third page) Tj ET\n${body(["Text on the third page."], 690)}`,
    `BT /F2 18 Tf 72 720 Td (Fourth page) Tj ET\n${body(["Text on the fourth page."], 690)}`,
  ];
  for (const ops of pages) {
    const res = doc.addObject({ Font: { F1: regular, F2: bold }, XObject: { Im0: image } });
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, ops));
  }
  const buf = doc.saveToBuffer("compress=yes");
  const out = buf.asUint8Array().slice();
  doc.destroy();
  return out;
}

const sample = work("sample.pdf", samplePdf());
const second = work("second-file.pdf", makeTextPdf(["Second file"]));
const third = work("third-file.pdf", makeTextPdf(["Third file"]));
const locked = work("protected.pdf", encryptPdf(samplePdf(), "letmein", "owner"));
const restricted = work("restricted.pdf", encryptPdf(samplePdf(), "", "owner", true));
const picture = work("picture.png", makePng(240, 120, [40, 110, 90]));
const picture2 = work("picture-2.png", makePng(120, 240, [190, 120, 60]));

const app = await electron.launch({ args: [ROOT, `--user-data-dir=${path.join(WORK, "profile")}`], cwd: ROOT });
const page = await app.firstWindow();
await page.waitForSelector("#btn-open");
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));

const stubOpen = (files: string | string[]) => app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: Array.isArray(files) ? files : [files] });
}, files);
const idle = async () => {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => document.body.style.cursor === "" || document.querySelector<HTMLDialogElement>("dialog[open]") !== null);
  await page.waitForTimeout(250);
};
const shot = async (name: string) => {
  await idle();
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(name);
};
const open = async (file: string) => {
  await stubOpen(file);
  await page.click("#btn-open");
  await page.waitForSelector('[data-testid="page-0"][data-rendered="true"]');
  await page.selectOption("#zoom-select", "1");
  await idle();
};
const at = async (x: number, y: number): Promise<[number, number]> => {
  const box = (await page.locator('[data-testid="page-0"]').boundingBox())!;
  return [box.x + x, box.y + y];
};
const drag = async (a: [number, number], b: [number, number]) => {
  const [x0, y0] = await at(...a);
  const [x1, y1] = await at(...b);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
  await idle();
};
const closeDialog = async () => {
  await page.click('#dialog button:has-text("Cancel")');
  await idle();
};

await shot("01-start-screen");

await open(sample);
await shot("02-main-viewer");

await page.click("#btn-tool-text");
const [tx, ty] = await at(330, 330);
await page.mouse.click(tx, ty);
await page.waitForSelector('[data-testid="inline-edit"]');
await page.keyboard.type("Typing new text");
await shot("03-add-text");
await page.keyboard.press("Control+Enter");
await idle();

await page.click("#btn-tool-highlight");
await drag([72, 118], [340, 118]);
await page.click("#btn-tool-rect");
await drag([330, 390], [520, 490]);
await page.click("#btn-tool-arrow");
await drag([100, 560], [300, 640]);
await page.click("#btn-tool-select");
const [sx, sy] = await at(425, 440);
await page.mouse.click(sx, sy);
await page.waitForSelector('[data-testid="sel-box"]');
await shot("04-object-selected");

await page.click("#btn-tool-whiteout");
const [wx0, wy0] = await at(72, 160);
const [wx1, wy1] = await at(320, 190);
await page.mouse.move(wx0, wy0);
await page.mouse.down();
await page.mouse.move(wx1, wy1, { steps: 4 });
await shot("05-whiteout-dragging");
await page.keyboard.press("Escape");
await page.mouse.move(wx1, wy0);
await page.mouse.up();
await idle();

await stubOpen(sample);
await page.click("#btn-open");
await page.waitForSelector('[data-testid="discard"]');
await shot("06-unsaved-changes-warning");
await page.click('[data-testid="discard"]');
await page.waitForFunction(() => document.querySelector('[data-testid="page-0"][data-rendered="true"]') !== null && !document.querySelector<HTMLDialogElement>("#dialog")!.open);
await page.selectOption("#zoom-select", "1");
await idle();

await page.click("#btn-tool-edittext");
await page.waitForSelector('[data-testid="line-box"]');
await shot("07-edit-text-mode");
await page.locator('[data-testid="line-box"]').nth(2).click();
await page.waitForSelector('[data-testid="inline-edit"]');
await shot("08-edit-text-active");
await page.keyboard.press("Escape");
await idle();

await page.click("#btn-tool-editimage");
await page.waitForSelector('[data-testid="img-box"]');
await page.click('[data-testid="img-box"]');
await page.waitForSelector('[data-testid="img-replace"]');
await shot("09-edit-image-mode");
await page.click("#btn-tool-select");
await idle();

await page.keyboard.press("Control+f");
await page.fill("#search-input", "text");
await page.waitForFunction(() => /of/.test(document.getElementById("search-count")!.textContent ?? ""));
await shot("10-find");
await page.click("#search-close");

await page.click('[data-testid="thumb-0"]');
await page.click('[data-testid="thumb-1"]', { modifiers: ["Control"] });
await shot("11-pages-selected");
await page.click('[data-testid="thumb-0"]');
await idle();

await page.click("#btn-tool-signature");
await page.waitForSelector("#sig-canvas");
const sig = (await page.locator("#sig-canvas").boundingBox())!;
await page.mouse.move(sig.x + 60, sig.y + 100);
await page.mouse.down();
await page.mouse.move(sig.x + 150, sig.y + 40, { steps: 5 });
await page.mouse.move(sig.x + 230, sig.y + 120, { steps: 5 });
await page.mouse.move(sig.x + 340, sig.y + 70, { steps: 5 });
await page.mouse.up();
await shot("12-signature-draw");
await page.click('[data-testid="sig-tab-type"]');
await page.fill('[data-testid="sig-typed"]', "Your Name");
await shot("13-signature-type");
await closeDialog();
await page.click("#btn-tool-select");

await page.click("#btn-merge");
await stubOpen([second, third]);
await page.click('[data-testid="merge-add"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-list"] li').length === 3);
await shot("14-merge-dialog");
await closeDialog();

await page.click("#btn-split");
await shot("15-split-dialog");
await closeDialog();

await page.click("#btn-img2pdf");
await stubOpen([picture, picture2]);
await page.click('[data-testid="img-add"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-list"] li').length === 2);
await shot("16-images-to-pdf-dialog");
await closeDialog();

await page.click("#btn-pdf2img");
await shot("17-pdf-to-images-dialog");
await closeDialog();

await page.click("#btn-compress");
await shot("18-compress-dialog");
await closeDialog();

await page.emulateMedia({ colorScheme: "dark" });
await shot("19-main-viewer-dark");
await page.emulateMedia({ colorScheme: "light" });

await stubOpen(locked);
await page.click("#btn-open");
await page.waitForSelector('[data-testid="password-input"]');
await page.fill('[data-testid="password-input"]', "wrong");
await page.click('[data-testid="password-ok"]');
await page.waitForSelector("text=That password is incorrect");
await shot("20-password-prompt");
await closeDialog();

await open(restricted);
await shot("21-read-only-banner");

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(0);
