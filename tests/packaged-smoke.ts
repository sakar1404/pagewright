// Confirms the packaged app (not just the dev build) starts, runs the PDF engine and edits a file.
import { _electron as electron } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PdfEngine } from "../src/engine/engine.ts";
import { makeTextPdf } from "./fixtures.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "test-output", "packaged");
mkdirSync(OUT, { recursive: true });
const input = path.join(OUT, "in.pdf");
const output = path.join(OUT, "out.pdf");
writeFileSync(input, makeTextPdf(["Packaged app line", "Second page"]));

const app = await electron.launch({
  executablePath: path.join(ROOT, "release", "win-unpacked", "Pagewright.exe"),
  args: [`--user-data-dir=${path.join(OUT, "profile")}`],
});
const page = await app.firstWindow();
await page.waitForSelector("#btn-open");
await app.evaluate(({ dialog }, { input, output }) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
}, { input, output });
await page.click("#btn-open");
await page.waitForSelector('[data-testid="page-0"][data-rendered="true"]');
await page.click("#btn-tool-edittext");
await page.locator('[data-testid="line-box"][title="Packaged app line"]').click();
await page.keyboard.press("Control+a");
await page.keyboard.type("Edited in the packaged app");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.title.startsWith("*"));
await page.click("#btn-saveas");
await page.waitForFunction(() => !document.title.startsWith("*"));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});

const engine = new PdfEngine();
engine.open(readFileSync(output));
const text = engine.pageText(0);
console.log(/Edited in the packaged app/.test(text) ? "packaged app ok" : `FAILED: ${text}`);
process.exit(/Edited in the packaged app/.test(text) ? 0 : 1);
