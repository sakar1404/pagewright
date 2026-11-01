// Stress check against real PDFs: node tests/realworld.ts <outDir> file1.pdf file2.pdf ...
// Input files are only read. Output goes to outDir.
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PdfEngine } from "../src/engine/engine.ts";

const [outDir, ...files] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

function timed<T>(label: string, work: () => T, log: string[]): T {
  const start = performance.now();
  const value = work();
  log.push(`${label} ${Math.round(performance.now() - start)}ms`);
  return value;
}

let failed = 0;
for (const file of files) {
  const name = path.basename(file, ".pdf").replace(/\W+/g, "_");
  const log: string[] = [];
  try {
    const engine = new PdfEngine();
    const bytes = readFileSync(file);
    const res = timed("open", () => engine.open(bytes), log);
    if (res.status !== "ok") throw new Error("needs a password");
    const info = res.info;
    if (!info.canEdit) { console.log(`${name}: restricted, skipped editing`); continue; }
    const sample = Math.min(info.pageCount - 1, 4);
    timed("render", () => engine.render(sample, 2), log);
    const lines = engine.textLines(sample);
    const hits = timed("searchAll", () => engine.search("the"), log);
    writeFileSync(path.join(outDir, `${name}_before.png`), engine.pageToImage(sample, 100, "png"));

    // Edit the longest plain line, keeping most of its words so the layout can be compared.
    const target = [...lines].filter((l) => /^[\x20-\x7e]+$/.test(l.text)).sort((a, b) => b.text.length - a.text.length)[0];
    let editOk = "no latin line";
    if (target) {
      // Replacing a line with identical text should barely change the page if the original font is reused.
      const shotBefore = engine.render(sample, 2);
      const info2 = engine.replaceTextLine(sample, target.bbox, target, target.text);
      const shotAfter = engine.render(sample, 2);
      let changed = 0;
      for (let p = 0; p < shotBefore.pixels.length; p += 4) if (Math.abs(shotBefore.pixels[p] - shotAfter.pixels[p]) > 96) changed++;
      log.push(`sameTextChangedPixels ${changed} font=${info2.fontFallback ? "standard" : "original"}`);
      writeFileSync(path.join(outDir, `${name}_sametext.png`), engine.pageToImage(sample, 100, "png"));
      engine.undo();
      const replacement = `EDITED ${target.text.slice(0, Math.max(0, target.text.length - 7))}`;
      const others = lines.filter((l) => l !== target).map((l) => l.text.trim()).filter(Boolean);
      timed("editLine", () => engine.replaceTextLine(sample, target.bbox, target, replacement), log);
      const after = engine.pageText(sample);
      const missing = others.filter((t) => !after.replace(/\s+/g, " ").includes(t.replace(/\s+/g, " ")));
      editOk = `old-gone=${!after.includes(target.text)} new-found=${after.includes("EDITED")} neighbours-lost=${missing.length}/${others.length}`;
      if (missing.length) editOk += ` e.g. "${missing[0]}"`;
    }
    timed("addText", () => engine.addText(0, { rect: [50, 50, 300, 90], text: "Annotation", fontSize: 12, color: [1, 0, 0] }), log);
    timed("rotate", () => engine.rotatePages([0], 90), log);
    timed("undo", () => engine.undo(), log);
    writeFileSync(path.join(outDir, `${name}_after.png`), engine.pageToImage(sample, 100, "png"));

    const saved = timed("save", () => engine.saveVerified(), log);
    const pageCount = engine.info().pageCount;
    const baseline = Array.from({ length: pageCount }, (_v, i) => engine.render(i, 0.5).pixels);
    const compressed = timed("compress", () => engine.compress(150, 65), log);
    // Mean colour difference per page, 0-255. A shift here means compression changed how a page looks.
    let worst = { page: -1, diff: 0 };
    for (let i = 0; i < pageCount; i++) {
      const a = baseline[i];
      const b = engine.render(i, 0.5).pixels;
      let sum = 0;
      for (let p = 0; p < a.length; p++) sum += Math.abs(a[p] - b[p]);
      const diff = sum / a.length;
      if (diff > worst.diff) worst = { page: i, diff };
    }
    log.push(`worstPageDiff ${worst.diff.toFixed(2)} on page ${worst.page + 1}`);
    if (worst.page >= 0) writeFileSync(path.join(outDir, `${name}_compressed_worst.png`), engine.pageToImage(worst.page, 100, "png"));
    const out = compressed.info.pageCount === info.pageCount ? engine.saveVerified() : saved;
    const check = new PdfEngine();
    check.open(out);
    const pagesOk = check.info().pageCount === info.pageCount;
    const annot = check.annotations(0).some((a) => a.text === "Annotation");
    console.log(`${name}: ${info.pageCount} pages, ${statSync(file).size} -> saved ${saved.length} -> compressed ${out.length} bytes. pagesOk=${pagesOk} annotKept=${annot} hits=${hits.length} ${editOk}\n   ${log.join(", ")}`);
    if (!pagesOk || !annot) failed++;
  } catch (err) {
    failed++;
    console.log(`${name}: FAILED ${(err as Error).message}; ${log.join(", ")}`);
  }
}
console.log(failed ? `${failed} file(s) failed` : "all files ok");
process.exit(failed ? 1 : 0);
