// UI-free PDF engine. Runs unchanged in Node (tests) and in a Web Worker (app).
import * as mupdf from "mupdf";

export type Rect = [number, number, number, number];
export type Point = [number, number];
export type Color = [number, number, number];
export type Quad = [number, number, number, number, number, number, number, number];

export type OpenResult =
  | { status: "needs-password"; wrongPassword: boolean }
  | { status: "ok"; info: DocInfo };

export interface DocInfo {
  pageCount: number;
  encrypted: boolean;
  /** False when the PDF restricts editing and the owner password was not given. */
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  /** The last edit could not use the document's own font and used the closest standard font. */
  fontFallback: boolean;
  pages: { width: number; height: number }[];
}

export interface TextLine {
  bbox: Rect;
  text: string;
  size: number;
  color: Color;
  font: StandardFontStyle;
  /** Baseline origin of the first character, in page coordinates. */
  origin: Point;
  /** Unit vector along the baseline, in page coordinates. */
  dir: Point;
}

export type EditableLine = Pick<TextLine, "origin" | "size" | "color" | "font" | "dir">;

export interface StandardFontStyle {
  family: "Helvetica" | "Times" | "Courier";
  bold: boolean;
  italic: boolean;
}

export interface PageImage {
  index: number;
  bbox: Rect;
  matrix: number[];
  width: number;
  height: number;
}

export type AnnotKind = "text" | "image" | "rect" | "ellipse" | "line" | "arrow" | "highlight";

export interface AnnotInfo {
  id: number;
  kind: AnnotKind | "other";
  rect: Rect;
  line?: [Point, Point];
  text?: string;
  fontSize?: number;
  color?: Color;
}

export interface AddTextArgs { rect: Rect; text: string; fontSize: number; color: Color }
export interface AddShapeArgs {
  kind: "rect" | "ellipse" | "line" | "arrow";
  rect: Rect;
  line?: [Point, Point];
  color: Color;
  fill?: Color | null;
  width: number;
}

export interface CompressResult { before: number; after: number; imagesRewritten: number }

const HISTORY_BYTE_BUDGET = 768 * 1024 * 1024;
const SAVE_FAST = "compress=no,encrypt=keep";
const SAVE_FINAL = "garbage=compact,compress=yes,objstms=yes,encrypt=keep";

/** Windows-1252 code points 0x80 to 0x9F, in byte order. */
const WIN_1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** Characters the standard PDF fonts cannot draw. Returned so the UI can refuse rather than drop them. */
export function unsupportedChars(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const latin1 = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
    if (!latin1 && !WIN_1252_HIGH.includes(ch) && ch !== "\n") bad.add(ch);
  }
  return [...bad];
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

const PAGE_EDGE_MARGIN = 18;

/** Some font formats cannot be re-embedded; the caller then falls back to a standard font. */
function tryAddFont(doc: mupdf.PDFDocument, font: mupdf.Font): mupdf.PDFObject | null {
  try {
    return doc.addFont(font);
  } catch {
    return null;
  }
}

function sameBytes(buffer: mupdf.Buffer): Uint8Array {
  const out = buffer.asUint8Array().slice();
  buffer.destroy();
  return out;
}

function openPdf(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
  if (doc.needsPassword() && password !== undefined) doc.authenticatePassword(password);
  return doc;
}

function imageFromBytes(bytes: Uint8Array): mupdf.Image {
  try {
    return new mupdf.Image(bytes);
  } catch {
    throw new Error("That image format is not supported. Use PNG, JPEG, TIFF, BMP or GIF.");
  }
}

const SANS_NAMES = /sans|arial|helvetica|myriad|frutiger|gill|segoe|calibri|verdana|tahoma|roboto|univers|futura|lato|inter/;
const SERIF_NAMES = /times|serif|georgia|garamond|minion|palatino|roman|cambria|book|caslon/;

/** Font names are more reliable than the flags, which subset fonts often set wrongly. */
function fontStyle(font: mupdf.Font): StandardFontStyle {
  const name = font.getName().toLowerCase();
  const family = font.isMono() || /cour|mono|consol/.test(name)
    ? "Courier"
    : SANS_NAMES.test(name)
      ? "Helvetica"
      : SERIF_NAMES.test(name) || font.isSerif()
        ? "Times"
        : "Helvetica";
  return {
    family,
    bold: font.isBold() || /bold|black|heavy/.test(name),
    italic: font.isItalic() || /italic|oblique/.test(name),
  };
}

function base14Name(style: StandardFontStyle): string {
  const { family, bold, italic } = style;
  if (family === "Times") {
    return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  }
  const suffix = bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "";
  return family + suffix;
}

function pdfString(text: string): string {
  // Base-14 fonts are added with Latin encoding; write bytes as a hex string.
  let hex = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const extra = WIN_1252_HIGH.indexOf(ch);
    const byte = extra >= 0 ? 0x80 + extra : code;
    hex += byte.toString(16).padStart(2, "0");
  }
  return `<${hex}>`;
}

function invert(m: number[]): number[] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function concat(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function applyMatrix(m: number[], p: Point): Point {
  return [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
}

function matrixBounds(m: number[]): Rect {
  const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
  const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function annotKind(type: string, annot: mupdf.PDFAnnotation): AnnotKind | "other" {
  switch (type) {
    case "FreeText": return "text";
    case "Stamp": return "image";
    case "Square": return "rect";
    case "Circle": return "ellipse";
    case "Highlight": return "highlight";
    case "Line": return annot.getLineEndingStyles().end === "None" ? "line" : "arrow";
    default: return "other";
  }
}

function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export class PdfEngine {
  private doc: mupdf.PDFDocument | null = null;
  private password: string | undefined;
  private canEdit = true;
  private encrypted = false;
  private fontFallback = false;
  private undoStack: Uint8Array[] = [];
  private redoStack: Uint8Array[] = [];
  private savedRevision = 0;
  private revision = 0;
  private nextRevision = 1;
  private revisions: { undo: number[]; redo: number[] } = { undo: [], redo: [] };
  private current: Uint8Array = new Uint8Array();

  // ---------- Open, info, save ----------

  open(data: Uint8Array | ArrayBuffer, password?: string): OpenResult {
    const bytes = toBytes(data).slice();
    let doc: mupdf.PDFDocument;
    try {
      doc = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
    } catch (err) {
      throw new Error(`This file could not be opened as a PDF. ${(err as Error).message}`);
    }
    const encrypted = doc.needsPassword();
    let authLevel = 0;
    if (encrypted) {
      authLevel = password === undefined ? 0 : doc.authenticatePassword(password);
      if (!authLevel) {
        doc.destroy();
        return { status: "needs-password", wrongPassword: password !== undefined };
      }
    }
    this.close();
    this.doc = doc;
    this.password = password;
    this.encrypted = encrypted || doc.getTrailer().get("Encrypt").isDictionary();
    // Bit 4 of the authenticate result means the owner password was given.
    this.canEdit = (authLevel & 4) !== 0 || doc.hasPermission("edit") || !this.encrypted;
    this.current = bytes;
    this.undoStack = [];
    this.redoStack = [];
    this.revisions = { undo: [], redo: [] };
    this.revision = 0;
    this.savedRevision = 0;
    this.nextRevision = 1;
    return { status: "ok", info: this.info() };
  }

  /** Unlock editing on a restricted PDF with its owner password. */
  unlockEditing(password: string): boolean {
    const doc = this.requireDoc();
    const level = doc.authenticatePassword(password);
    if ((level & 4) === 0) return false;
    this.password = password;
    this.canEdit = true;
    return true;
  }

  close(): void {
    this.doc?.destroy();
    this.doc = null;
    this.password = undefined;
  }

  info(): DocInfo {
    const doc = this.requireDoc();
    const count = doc.countPages();
    const pages: DocInfo["pages"] = [];
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      pages.push({ width: b[2] - b[0], height: b[3] - b[1] });
      page.destroy();
    }
    return {
      pageCount: count,
      encrypted: this.encrypted,
      canEdit: this.canEdit,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      dirty: this.revision !== this.savedRevision,
      fontFallback: this.fontFallback,
      pages,
    };
  }

  /**
   * Final bytes for writing to disk. Call markSaved once the write succeeded.
   * Works on a copy: garbage collection renumbers objects in place, which would
   * invalidate the object ids the UI holds for the open document.
   */
  save(options = SAVE_FINAL): Uint8Array {
    this.requireDoc();
    const copy = openPdf(this.current.slice(), this.password);
    const out = sameBytes(copy.saveToBuffer(options));
    copy.destroy();
    return out;
  }

  /** Save bytes, confirmed to reopen with the same page count, so a bad write never replaces a good file. */
  saveVerified(): Uint8Array {
    const bytes = this.save();
    const check = openPdf(bytes.slice(), this.password);
    const ok = check.countPages() === this.requireDoc().countPages();
    check.destroy();
    if (!ok) throw new Error("The save could not be verified, so the file on disk was left as it was.");
    return bytes;
  }

  markSaved(): DocInfo {
    this.savedRevision = this.revision;
    return this.info();
  }

  // ---------- Viewing ----------

  /** RGBA pixels for a page at the given scale (1 = 72 dpi). */
  render(pageIndex: number, scale: number): { width: number; height: number; pixels: Uint8ClampedArray } {
    const page = this.requireDoc().loadPage(pageIndex);
    try {
      // Paint on opaque white like paper: blend modes such as a highlight's multiply need a backdrop.
      const matrix = mupdf.Matrix.scale(scale, scale);
      const b = mupdf.Rect.transform(page.getBounds(), matrix);
      const bbox: Rect = [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])];
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
      pix.clear(255);
      const device = new mupdf.DrawDevice(matrix, pix);
      page.run(device, mupdf.Matrix.identity);
      device.close();
      device.destroy();
      const result = { width: pix.getWidth(), height: pix.getHeight(), pixels: pix.getPixels().slice() };
      pix.destroy();
      return result;
    } finally {
      page.destroy();
    }
  }

  search(needle: string): { page: number; quads: Quad[] }[] {
    const doc = this.requireDoc();
    const hits: { page: number; quads: Quad[] }[] = [];
    if (!needle) return hits;
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      for (const quads of page.search(needle, "ignore-case")) hits.push({ page: i, quads: quads as Quad[] });
      page.destroy();
    }
    return hits;
  }

  textLines(pageIndex: number): TextLine[] {
    const page = this.requireDoc().loadPage(pageIndex);
    const stext = page.toStructuredText("preserve-spans");
    const lines: RawLine[] = [];
    let cur: RawLine | null = null;
    stext.walk({
      beginLine(bbox, _wmode, direction) {
        cur = {
          bbox: [bbox[0], bbox[1], bbox[2], bbox[3]], text: "", size: 0, color: [0, 0, 0],
          font: { family: "Helvetica", bold: false, italic: false }, origin: [bbox[0], bbox[3]],
          dir: [direction[0], direction[1]],
        };
      },
      onChar(c, origin, font, size, _quad, color) {
        if (!cur) return;
        // Lines often start with an invisible space; anchor to the first visible character.
        if (!cur.hasInk && c.trim()) {
          cur.hasInk = true;
          cur.size = size;
          cur.origin = [origin[0], origin[1]];
          cur.font = fontStyle(font);
          cur.color = colorToRgb(color as number[]);
        }
        cur.text += c;
      },
      endLine() {
        if (cur && cur.text.trim()) lines.push(cur);
        cur = null;
      },
    });
    stext.destroy();
    page.destroy();
    return mergeSpans(lines).map(({ hasInk: _hasInk, ...line }) => ({
      ...line,
      text: line.text.trim(),
      bbox: Math.abs(line.dir[1]) < 0.01 ? [Math.max(line.bbox[0], line.origin[0]), line.bbox[1], line.bbox[2], line.bbox[3]] as Rect : line.bbox,
    }));
  }

  pageText(pageIndex: number): string {
    const page = this.requireDoc().loadPage(pageIndex);
    const stext = page.toStructuredText("");
    const text = stext.asText();
    stext.destroy();
    page.destroy();
    return text;
  }

  /** Quads for a text selection dragged from p to q. */
  selectionQuads(pageIndex: number, p: Point, q: Point): Quad[] {
    const page = this.requireDoc().loadPage(pageIndex);
    const stext = page.toStructuredText("");
    const quads = stext.highlight(p, q) as Quad[];
    stext.destroy();
    page.destroy();
    return quads;
  }

  pageImages(pageIndex: number): PageImage[] {
    const page = this.requireDoc().loadPage(pageIndex);
    const images: PageImage[] = [];
    const device = new mupdf.Device({
      fillImage(image: mupdf.Image, ctm: number[]) {
        images.push({
          index: images.length,
          bbox: matrixBounds(ctm),
          matrix: [...ctm],
          width: image.getWidth(),
          height: image.getHeight(),
        });
      },
    } as never);
    page.runPageContents(device, mupdf.Matrix.identity);
    device.close();
    device.destroy();
    page.destroy();
    return images;
  }

  annotations(pageIndex: number): AnnotInfo[] {
    const page = this.requireDoc().loadPage(pageIndex) as mupdf.PDFPage;
    const out = page.getAnnotations().map((annot) => this.annotInfo(annot));
    page.destroy();
    return out;
  }

  private annotInfo(annot: mupdf.PDFAnnotation): AnnotInfo {
    const type = annot.getType();
    const info: AnnotInfo = {
      id: annot.getObject().asIndirect(),
      kind: annotKind(type, annot),
      rect: annot.getBounds() as Rect,
    };
    if (type === "FreeText") {
      info.text = annot.getContents();
      const da = annot.getDefaultAppearance();
      info.fontSize = da.size;
      info.color = colorToRgb(da.color as number[]);
    }
    if (type === "Line") info.line = annot.getLine() as [Point, Point];
    return info;
  }

  // ---------- Add objects (real annotations, movable later) ----------

  addText(pageIndex: number, args: AddTextArgs): DocInfo {
    return this.edit((doc) => {
      this.rejectUnsupported(args.text);
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      const annot = page.createAnnotation("FreeText");
      annot.setRect(normRect(args.rect));
      annot.setContents(args.text);
      annot.setDefaultAppearance("Helv", args.fontSize, args.color);
      annot.setBorderWidth(0);
      annot.update();
      page.destroy();
    });
  }

  /** Images and signatures both land here; a signature is an image the user drew. */
  addImage(pageIndex: number, rect: Rect, imageBytes: Uint8Array): DocInfo {
    return this.edit((doc) => {
      const image = imageFromBytes(imageBytes);
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      const annot = page.createAnnotation("Stamp");
      annot.setRect(normRect(rect));
      annot.setStampImage(image);
      annot.update();
      page.destroy();
      image.destroy();
    });
  }

  addShape(pageIndex: number, args: AddShapeArgs): DocInfo {
    return this.edit((doc) => {
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      const type = args.kind === "rect" ? "Square" : args.kind === "ellipse" ? "Circle" : "Line";
      const annot = page.createAnnotation(type);
      annot.setColor(args.color);
      annot.setBorderWidth(args.width);
      if (type === "Line") {
        const line = args.line ?? [[args.rect[0], args.rect[1]], [args.rect[2], args.rect[3]]] as [Point, Point];
        annot.setLine(line[0], line[1]);
        if (args.kind === "arrow") annot.setLineEndingStyles("None", "OpenArrow");
      } else {
        annot.setRect(normRect(args.rect));
        if (args.fill) annot.setInteriorColor(args.fill);
      }
      annot.update();
      page.destroy();
    });
  }

  /** Highlight a text selection dragged from p to q. Returns null when no text was under the drag. */
  addHighlight(pageIndex: number, p: Point, q: Point, color: Color): DocInfo | null {
    if (!this.selectionQuads(pageIndex, p, q).length) return null;
    return this.edit((doc) => {
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      const stext = page.toStructuredText("");
      const quads = stext.highlight(p, q) as Quad[];
      stext.destroy();
      const annot = page.createAnnotation("Highlight");
      annot.setColor(color);
      annot.setOpacity(0.4);
      annot.setQuadPoints(quads);
      annot.update();
      page.destroy();
    });
  }

  moveAnnotation(pageIndex: number, id: number, rect: Rect, line?: [Point, Point]): DocInfo {
    return this.edit((doc) => {
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      const annot = this.findAnnot(page, id);
      if (annot.getType() === "Line" && line) annot.setLine(line[0], line[1]);
      else if (annot.getType() === "Highlight") {
        const old = annot.getBounds();
        const dx = rect[0] - old[0];
        const dy = rect[1] - old[1];
        const quads = annot.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)) as Quad);
        annot.setQuadPoints(quads);
      } else annot.setRect(normRect(rect));
      annot.update();
      page.destroy();
    });
  }

  updateAnnotationText(pageIndex: number, id: number, text: string): DocInfo {
    return this.edit((doc) => {
      this.rejectUnsupported(text);
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      const annot = this.findAnnot(page, id);
      annot.setContents(text);
      annot.update();
      page.destroy();
    });
  }

  deleteAnnotation(pageIndex: number, id: number): DocInfo {
    return this.edit((doc) => {
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      page.deleteAnnotation(this.findAnnot(page, id));
      page.destroy();
    });
  }

  /** Bake every annotation into the page content so it can no longer be moved. */
  flatten(): DocInfo {
    return this.edit((doc) => doc.bake(true, false));
  }

  // ---------- Edit page content ----------

  /** Paints white and permanently removes the text, pixels and line art underneath. */
  whiteout(pageIndex: number, rect: Rect): DocInfo {
    return this.edit((doc) => {
      const r = normRect(rect);
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      this.redact(page, [r], mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      const [x0, y0, x1, y1] = this.toPdfRect(page, r);
      this.appendContent(doc, page, `1 1 1 rg ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f\n`);
      page.destroy();
    });
  }

  /**
   * Replace one text line at the same size and colour. Uses the document's own font when it
   * has every character (embedded fonts are often subsets), otherwise the closest standard font.
   * DocInfo.fontFallback reports which happened.
   */
  replaceTextLine(pageIndex: number, bbox: Rect, line: EditableLine, text: string): DocInfo {
    return this.edit((doc) => {
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      // The stext page owns the font objects, so it stays alive until the new text is drawn.
      const stext = page.toStructuredText("preserve-spans");
      let original: mupdf.Font | null = null;
      stext.walk({
        onChar(_c, origin, font) {
          if (!original && Math.hypot(origin[0] - line.origin[0], origin[1] - line.origin[1]) < 1) original = font;
        },
      });
      // Trim the box vertically so descenders of the line above stay untouched.
      const inset = (bbox[3] - bbox[1]) * 0.25;
      const region: Rect = [bbox[0] - 0.5, bbox[1] + inset, bbox[2] + 0.5, bbox[3] - inset];
      this.redact(page, [region], mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      if (text.trim()) this.drawText(doc, page, line, text, original);
      stext.destroy();
      page.destroy();
    });
  }

  deleteImage(pageIndex: number, imageIndex: number): DocInfo {
    return this.edit((doc) => {
      const target = this.imageAt(pageIndex, imageIndex);
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      this.redact(page, [centerRegion(target.bbox)], mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_NONE);
      page.destroy();
    });
  }

  replaceImage(pageIndex: number, imageIndex: number, imageBytes: Uint8Array): DocInfo {
    return this.edit((doc) => {
      const target = this.imageAt(pageIndex, imageIndex);
      const image = imageFromBytes(imageBytes);
      const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
      this.redact(page, [centerRegion(target.bbox)], mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_NONE);
      const ref = doc.addImage(image);
      const name = this.addResource(doc, page, "XObject", "PSIm", ref);
      const m = concat(target.matrix, invert(page.getTransform()));
      this.appendContent(doc, page, `${m.join(" ")} cm /${name} Do\n`);
      page.destroy();
      image.destroy();
    });
  }

  private imageAt(pageIndex: number, imageIndex: number): PageImage {
    const target = this.pageImages(pageIndex)[imageIndex];
    if (!target) throw new Error("That image is no longer on the page.");
    return target;
  }

  private redact(page: mupdf.PDFPage, rects: Rect[], image: number, lineArt: number, text: number): void {
    for (const rect of rects) {
      const annot = page.createAnnotation("Redact");
      annot.setRect(rect);
      annot.update();
    }
    page.applyRedactions(false, image, lineArt, text);
  }

  private drawText(doc: mupdf.PDFDocument, page: mupdf.PDFPage, line: EditableLine, text: string, original: mupdf.Font | null): void {
    let measure: mupdf.Font;
    let fontRef: mupdf.PDFObject;
    let encoded: string;
    const gids = original ? [...text].map((ch) => original!.encodeCharacter(ch.codePointAt(0)!)) : [];
    const embedded = original && gids.every((gid) => gid > 0) ? tryAddFont(doc, original) : null;
    if (embedded) {
      measure = original!;
      fontRef = embedded;
      encoded = `<${gids.map((gid) => gid.toString(16).padStart(4, "0")).join("")}>`;
    } else {
      this.rejectUnsupported(text);
      this.fontFallback = true;
      measure = new mupdf.Font(base14Name(line.font));
      fontRef = doc.addSimpleFont(measure, "Latin");
      encoded = pdfString(text);
    }
    const name = this.addResource(doc, page, "Font", "PSF", fontRef);
    const [x, y] = applyMatrix(page.getTransform(), line.origin);
    // A longer line is squeezed rather than allowed to run off the page. Other text is not reflowed.
    let stretch = "";
    if (Math.abs(line.dir[1]) < 0.01) {
      const width = [...text].reduce((sum, ch) => sum + measure.advanceGlyph(measure.encodeCharacter(ch.codePointAt(0)!), 0), 0) * line.size;
      const room = page.getBounds()[2] - line.origin[0] - PAGE_EDGE_MARGIN;
      if (room > 0 && width > room) stretch = `${(room / width) * 100} Tz `;
    }
    const [r, g, b] = line.color;
    // Keep the original baseline direction, which also covers rotated pages and rotated text.
    const t = page.getTransform();
    const dx = line.dir[0] * t[0] + line.dir[1] * t[2];
    const dy = line.dir[0] * t[1] + line.dir[1] * t[3];
    const len = Math.hypot(dx, dy) || 1;
    const [c, s] = [dx / len, dy / len];
    this.appendContent(doc, page, `${r} ${g} ${b} rg BT /${name} ${line.size} Tf ${c} ${s} ${-s} ${c} ${x} ${y} Tm ${stretch}${encoded} Tj ET\n`);
  }

  private toPdfRect(page: mupdf.PDFPage, rect: Rect): Rect {
    return normRect(mupdf.Rect.transform(rect, page.getTransform()) as Rect);
  }

  private addResource(doc: mupdf.PDFDocument, page: mupdf.PDFPage, category: string, prefix: string, ref: mupdf.PDFObject): string {
    const pageObj = page.getObject();
    let resources = pageObj.getInheritable("Resources");
    if (resources.isNull()) {
      resources = doc.newDictionary();
      pageObj.put("Resources", resources);
    } else if (pageObj.get("Resources").isNull()) {
      // Inherited resources are shared with other pages; give this page its own copy.
      const own = doc.newDictionary();
      resources.forEach((value: mupdf.PDFObject, key: string | number) => own.put(key as string, value));
      pageObj.put("Resources", own);
      resources = pageObj.get("Resources");
    }
    let dict = resources.get(category);
    if (dict.isNull()) {
      dict = doc.newDictionary();
      resources.put(category, dict);
    }
    let n = 0;
    while (!dict.get(`${prefix}${n}`).isNull()) n++;
    dict.put(`${prefix}${n}`, ref);
    return `${prefix}${n}`;
  }

  private appendContent(doc: mupdf.PDFDocument, page: mupdf.PDFPage, ops: string): void {
    const pageObj = page.getObject();
    const contents = pageObj.get("Contents");
    const before = doc.addStream("q\n", {});
    const after = doc.addStream(`Q\nq\n${ops}Q\n`, {});
    const list = doc.newArray();
    list.push(before);
    if (contents.isArray()) contents.forEach((c: mupdf.PDFObject) => list.push(c));
    else if (!contents.isNull()) list.push(contents);
    list.push(after);
    pageObj.put("Contents", list);
  }

  // ---------- Page operations ----------

  deletePages(pages: number[]): DocInfo {
    this.requireEditable();
    const keep = this.remaining(pages);
    if (!keep.length) throw new Error("A PDF must keep at least one page.");
    return this.edit((doc) => doc.rearrangePages(keep));
  }

  rotatePages(pages: number[], degrees: 90 | -90 | 180): DocInfo {
    return this.edit((doc) => {
      for (const i of pages) {
        const obj = doc.findPage(i);
        const current = obj.getInheritable("Rotate").asNumber() || 0;
        obj.put("Rotate", ((current + degrees) % 360 + 360) % 360);
      }
    });
  }

  /** order lists the old page index for each new position. */
  reorderPages(order: number[]): DocInfo {
    const count = this.requireDoc().countPages();
    if (order.length !== count || new Set(order).size !== count) throw new Error("Page order must include every page once.");
    return this.edit((doc) => doc.rearrangePages(order));
  }

  /** New PDF containing the listed pages, in the listed order. The open document is untouched. */
  extractPages(pages: number[]): Uint8Array {
    const copy = openPdf(this.current.slice(), this.password);
    copy.rearrangePages(pages);
    const out = sameBytes(copy.saveToBuffer("garbage=compact,compress=yes,encrypt=none"));
    copy.destroy();
    return out;
  }

  /** Split into one PDF per range. Ranges are 0-based inclusive pairs. */
  split(ranges: [number, number][]): Uint8Array[] {
    return ranges.map(([from, to]) => {
      const pages: number[] = [];
      for (let i = from; i <= to; i++) pages.push(i);
      return this.extractPages(pages);
    });
  }

  /** Append other PDFs to the open document. */
  appendPdf(data: Uint8Array, password?: string): DocInfo {
    return this.edit((doc) => {
      const other = openForMerge(data, password);
      const at = doc.countPages();
      const count = other.countPages();
      for (let i = 0; i < count; i++) doc.graftPage(at + i, other, i);
      other.destroy();
    });
  }

  // ---------- Convert ----------

  pageToImage(pageIndex: number, dpi: number, format: "png" | "jpeg", jpegQuality = 90): Uint8Array {
    const page = this.requireDoc().loadPage(pageIndex);
    const scale = dpi / 72;
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    pix.setResolution(dpi, dpi);
    const out = (format === "png" ? pix.asPNG() : pix.asJPEG(jpegQuality)).slice();
    pix.destroy();
    page.destroy();
    return out;
  }

  // ---------- Compress ----------

  /**
   * Downsamples images above maxDpi to JPEG at the given quality, subsets fonts,
   * and rewrites the file with unused objects removed. Undoable like any edit.
   * An image is only replaced when the new version is actually smaller.
   */
  compress(maxDpi: number, jpegQuality: number): { info: DocInfo; result: CompressResult } {
    const before = this.save().length;
    let imagesRewritten = 0;
    const info = this.edit((doc) => {
      imagesRewritten = rewriteImages(doc, maxDpi, jpegQuality);
      doc.subsetFonts();
    });
    return { info, result: { before, after: this.save().length, imagesRewritten } };
  }

  // ---------- Undo / redo ----------

  undo(): DocInfo {
    const previous = this.undoStack.pop();
    if (!previous) return this.info();
    this.redoStack.push(this.current);
    this.revisions.redo.push(this.revision);
    this.revision = this.revisions.undo.pop()!;
    this.restore(previous);
    return this.info();
  }

  redo(): DocInfo {
    const next = this.redoStack.pop();
    if (!next) return this.info();
    this.undoStack.push(this.current);
    this.revisions.undo.push(this.revision);
    this.revision = this.revisions.redo.pop()!;
    this.restore(next);
    return this.info();
  }

  private restore(bytes: Uint8Array): void {
    this.doc?.destroy();
    this.doc = openPdf(bytes, this.password);
    this.current = bytes;
  }

  /** Runs a mutation. On any failure the document is restored, so a failed edit leaves nothing behind. */
  private edit(mutate: (doc: mupdf.PDFDocument) => void): DocInfo {
    const doc = this.requireDoc();
    this.requireEditable();
    this.fontFallback = false;
    try {
      mutate(doc);
    } catch (err) {
      this.restore(this.current);
      throw err;
    }
    this.undoStack.push(this.current);
    this.revisions.undo.push(this.revision);
    this.redoStack = [];
    this.revisions.redo = [];
    this.current = sameBytes(doc.saveToBuffer(SAVE_FAST));
    this.revision = this.nextRevision++;
    this.trimHistory();
    // Reload so page objects, annotation lists and caches all reflect the saved state.
    this.restore(this.current);
    return this.info();
  }

  private trimHistory(): void {
    let total = this.undoStack.reduce((sum, b) => sum + b.length, 0);
    while (total > HISTORY_BYTE_BUDGET && this.undoStack.length > 1) {
      total -= this.undoStack.shift()!.length;
      this.revisions.undo.shift();
    }
  }

  private requireEditable(): void {
    if (!this.canEdit) throw new Error("This PDF restricts editing. Enter the owner password to change it.");
  }

  private rejectUnsupported(text: string): void {
    const bad = unsupportedChars(text);
    if (bad.length) throw new Error(`These characters cannot be written with the standard PDF fonts: ${bad.join(" ")}`);
  }

  private findAnnot(page: mupdf.PDFPage, id: number): mupdf.PDFAnnotation {
    const annot = page.getAnnotations().find((a) => a.getObject().asIndirect() === id);
    if (!annot) throw new Error("That object is no longer on the page.");
    return annot;
  }

  private remaining(pages: number[]): number[] {
    const count = this.requireDoc().countPages();
    const removed = new Set(pages);
    const keep: number[] = [];
    for (let i = 0; i < count; i++) if (!removed.has(i)) keep.push(i);
    return keep;
  }

  private requireDoc(): mupdf.PDFDocument {
    if (!this.doc) throw new Error("No document is open.");
    return this.doc;
  }
}

function centerRegion(b: Rect): Rect {
  // A small box at the image centre selects that image without touching neighbours.
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const hw = Math.max(0.5, (b[2] - b[0]) * 0.05);
  const hh = Math.max(0.5, (b[3] - b[1]) * 0.05);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

function colorToRgb(color: number[]): Color {
  if (!color || color.length === 0) return [0, 0, 0];
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 3) return [color[0], color[1], color[2]];
  const [c, m, y, k] = color;
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

type RawLine = TextLine & { hasInk?: boolean };

/** With preserve-spans, style changes split a line; join pieces sharing a baseline. */
function mergeSpans(lines: RawLine[]): RawLine[] {
  const out: RawLine[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    const sameBaseline = last && Math.abs(last.origin[1] - line.origin[1]) < 0.5;
    const adjacent = last && line.bbox[0] - last.bbox[2] < last.size * 1.5 && line.bbox[0] >= last.bbox[0];
    if (last && sameBaseline && adjacent) {
      last.text += line.text;
      last.bbox = [Math.min(last.bbox[0], line.bbox[0]), Math.min(last.bbox[1], line.bbox[1]), Math.max(last.bbox[2], line.bbox[2]), Math.max(last.bbox[3], line.bbox[3])];
    } else out.push({ ...line });
  }
  return out;
}

function openForMerge(data: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(data.slice(), "application/pdf") as mupdf.PDFDocument;
  if (doc.needsPassword() && (password === undefined || !doc.authenticatePassword(password))) {
    doc.destroy();
    throw new NeedsPasswordError();
  }
  return doc;
}

export class NeedsPasswordError extends Error {
  constructor() {
    super("needs-password");
    this.name = "NeedsPasswordError";
  }
}

/** Largest pixel density at which an image is drawn on any page, by object number. */
function imageDensities(doc: mupdf.PDFDocument): Map<number, number> {
  const best = new Map<number, number>();
  const bySize = new Map<string, number[]>();
  const objects = doc.countObjects();
  for (let num = 1; num < objects; num++) {
    const obj = doc.newIndirect(num);
    if (obj.get("Subtype").asName() !== "Image") continue;
    const key = `${obj.get("Width").asNumber()}x${obj.get("Height").asNumber()}`;
    bySize.set(key, [...(bySize.get(key) ?? []), num]);
  }
  const count = doc.countPages();
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    const seen: { w: number; h: number; dpi: number }[] = [];
    const device = new mupdf.Device({
      fillImage(image: mupdf.Image, ctm: number[]) {
        const widthInches = Math.hypot(ctm[0], ctm[1]) / 72;
        const heightInches = Math.hypot(ctm[2], ctm[3]) / 72;
        const dpi = Math.max(image.getWidth() / Math.max(widthInches, 0.001), image.getHeight() / Math.max(heightInches, 0.001));
        seen.push({ w: image.getWidth(), h: image.getHeight(), dpi });
      },
    } as never);
    page.run(device, mupdf.Matrix.identity);
    device.close();
    device.destroy();
    for (const s of seen) {
      for (const num of bySize.get(`${s.w}x${s.h}`) ?? []) best.set(num, Math.max(best.get(num) ?? 0, s.dpi));
    }
    page.destroy();
  }
  return best;
}

function rewriteImages(doc: mupdf.PDFDocument, maxDpi: number, quality: number): number {
  let rewritten = 0;
  const densities = imageDensities(doc);
  for (const [num, dpi] of densities) {
    const obj = doc.newIndirect(num);
    if (obj.get("ImageMask").asBoolean()) continue;
    const width = obj.get("Width").asNumber();
    const height = obj.get("Height").asNumber();
    if (width < 16 || height < 16) continue;
    const ratio = dpi > maxDpi ? maxDpi / dpi : 1;
    const newWidth = Math.max(1, Math.round(width * ratio));
    const newHeight = Math.max(1, Math.round(height * ratio));

    const image = doc.loadImage(obj);
    const source = image.toPixmap();
    let pix = source.getColorSpace()?.isRGB() || source.getColorSpace()?.isGray()
      ? source
      : source.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
    if (pix.getAlpha()) {
      const flat = new mupdf.Pixmap(pix.getColorSpace()!, [0, 0, width, height], false);
      flat.clear(255);
      const flatDevice = new mupdf.DrawDevice(mupdf.Matrix.identity, flat);
      flatDevice.fillImage(new mupdf.Image(pix), [width, 0, 0, height, 0, 0], 1);
      flatDevice.close();
      flatDevice.destroy();
      pix = flat;
    }
    if (newWidth !== width || newHeight !== height) {
      const scaled = new mupdf.Pixmap(pix.getColorSpace()!, [0, 0, newWidth, newHeight], false);
      const draw = new mupdf.DrawDevice(mupdf.Matrix.identity, scaled);
      draw.fillImage(new mupdf.Image(pix), [newWidth, 0, 0, newHeight, 0, 0], 1);
      draw.close();
      draw.destroy();
      pix = scaled;
    }
    const jpeg = pix.asJPEG(quality).slice();
    const oldSize = obj.readRawStream().getLength();
    if (jpeg.length < oldSize) {
      obj.writeRawStream(jpeg);
      obj.put("Filter", "DCTDecode");
      obj.delete("DecodeParms");
      obj.delete("Decode");
      obj.put("Width", newWidth);
      obj.put("Height", newHeight);
      obj.put("BitsPerComponent", 8);
      obj.put("ColorSpace", pix.getColorSpace()!.isGray() ? "DeviceGray" : "DeviceRGB");
      rewritten++;
    }
  }
  return rewritten;
}

/** Build a PDF with one page per image. fit=null sizes each page to its image at 72 dpi-equivalent. */
export function imagesToPdf(images: Uint8Array[], options: { pageSize: "image" | "a4" | "letter"; margin: number }): Uint8Array {
  if (!images.length) throw new Error("Choose at least one image.");
  const doc = new mupdf.PDFDocument();
  const sizes = { a4: [595.28, 841.89], letter: [612, 792] } as const;
  for (const bytes of images) {
    const image = imageFromBytes(bytes);
    const xres = image.getXResolution() || 96;
    const yres = image.getYResolution() || 96;
    const naturalW = (image.getWidth() * 72) / xres;
    const naturalH = (image.getHeight() * 72) / yres;
    let pageW = naturalW + options.margin * 2;
    let pageH = naturalH + options.margin * 2;
    if (options.pageSize !== "image") {
      const [w, h] = sizes[options.pageSize];
      [pageW, pageH] = naturalW > naturalH ? [h, w] : [w, h];
    }
    const availW = pageW - options.margin * 2;
    const availH = pageH - options.margin * 2;
    const scale = Math.min(availW / naturalW, availH / naturalH);
    const drawW = naturalW * scale;
    const drawH = naturalH * scale;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;
    const resources = doc.addObject({ XObject: { Im0: doc.addImage(image) } });
    const contents = `q ${drawW} 0 0 ${drawH} ${x} ${y} cm /Im0 Do Q\n`;
    const pageObj = doc.addPage([0, 0, pageW, pageH], 0, resources, contents);
    doc.insertPage(-1, pageObj);
    image.destroy();
  }
  const out = sameBytes(doc.saveToBuffer("garbage=compact,compress=yes"));
  doc.destroy();
  return out;
}

/** Merge several PDFs in order into a new file. */
export function mergePdfs(files: { data: Uint8Array; password?: string }[]): Uint8Array {
  if (files.length < 1) throw new Error("Choose at least one PDF.");
  const out = new mupdf.PDFDocument();
  for (const file of files) {
    const src = openForMerge(file.data, file.password);
    const count = src.countPages();
    for (let i = 0; i < count; i++) out.graftPage(-1, src, i);
    src.destroy();
  }
  const bytes = sameBytes(out.saveToBuffer("garbage=compact,compress=yes"));
  out.destroy();
  return bytes;
}

/** Test helper and app feature: encrypt a copy with a user and owner password. */
export function encryptPdf(data: Uint8Array, userPassword: string, ownerPassword: string, restrictEditing = false): Uint8Array {
  const doc = openPdf(data.slice());
  const perms = restrictEditing ? ",permissions=-44" : "";
  const out = sameBytes(doc.saveToBuffer(`encrypt=aes-256,user-password=${userPassword},owner-password=${ownerPassword}${perms}`));
  doc.destroy();
  return out;
}
