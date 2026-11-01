// Builds test documents at run time, so the repo carries no binary fixtures.
import * as mupdf from "mupdf";

function finish(doc: mupdf.PDFDocument): Uint8Array {
  const buf = doc.saveToBuffer("compress=yes");
  const out = buf.asUint8Array().slice();
  buf.destroy();
  doc.destroy();
  return out;
}

function escape(s: string): string {
  return s.replace(/([\\()])/g, "\\$1");
}

/** One Letter page per entry. A newline in an entry starts another text line. */
export function makeTextPdf(pages: string[]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  for (const text of pages) {
    const lines = text.split("\n");
    const ops = lines.map((l, i) => `BT /F1 14 Tf 72 ${720 - i * 24} Td (${escape(l)}) Tj ET`).join("\n");
    const res = doc.addObject({ Font: { F1: font } });
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, ops));
  }
  return finish(doc);
}

/** Single page with an image at a top-left-origin rectangle, plus optional text. */
export function makeImagePdf(png: Uint8Array, rect: number[], caption?: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const image = doc.addImage(new mupdf.Image(png));
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  const [x0, y0, x1, y1] = rect;
  let ops = `q ${x1 - x0} 0 0 ${y1 - y0} ${x0} ${792 - y1} cm /Im0 Do Q\n`;
  if (caption) ops += `BT /F1 14 Tf 72 40 Td (${escape(caption)}) Tj ET\n`;
  const res = doc.addObject({ XObject: { Im0: image }, Font: { F1: font } });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, ops));
  return finish(doc);
}

export function makePng(width: number, height: number, rgb: number[]): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const px = pix.getPixels();
  for (let i = 0; i < px.length; i += 3) {
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
  }
  const out = pix.asPNG().slice();
  pix.destroy();
  return out;
}

/** Hard-to-compress image: PNG stays large, so downsampling has a real effect. */
export function makeNoisyPng(width: number, height: number): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const px = pix.getPixels();
  let seed = 12345;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed >> 16;
  }
  const out = pix.asPNG().slice();
  pix.destroy();
  return out;
}
