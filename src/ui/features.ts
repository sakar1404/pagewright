// Dialog-driven features: signature, merge, split, convert, compress.
import { pdf } from "./rpc.ts";
import { el, field, showDialog } from "./dialogs.ts";
import { parseRanges, rangesToPages } from "./ranges.ts";
import { icons } from "./icons.ts";
import type { CompressResult, DocInfo } from "../engine/engine.ts";

const PDF_FILTER = [{ name: "PDF documents", extensions: ["pdf"] }];
const SIGNATURE_KEY = "pagewright.signature";

function dataUrlToBytes(url: string): Uint8Array {
  return Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
}

function errorLine(): HTMLParagraphElement {
  return el("p", { className: "error-text", role: "alert", hidden: true, dataset: { testid: "dialog-error" } });
}

function note(text: string): HTMLElement {
  const node = el("div", { className: "note" });
  node.innerHTML = icons.info;
  node.append(el("span", { textContent: text }));
  return node;
}

function iconButton(label: string, icon: string, props: { disabled?: boolean; onclick?: () => void } = {}): HTMLButtonElement {
  const node = el("button", { type: "button", title: label, ariaLabel: label, ...props });
  node.innerHTML = icons[icon];
  return node;
}

function addButton(label: string, testid: string, onclick: () => void): HTMLButtonElement {
  const node = el("button", { type: "button", className: "secondary add-btn", dataset: { testid }, onclick });
  node.innerHTML = icons.plus;
  node.append(label);
  return node;
}

/** A selectable card holding a radio button, used by split and compress. */
function choice(input: HTMLInputElement, title: (Node | string)[], sub = "", side = ""): HTMLLabelElement {
  const main = el("span", { className: "c-main" }, el("span", { className: "c-title" }, ...title));
  if (sub) main.append(el("span", { className: "c-sub", textContent: sub }));
  const node = el("label", { className: "choice" }, input, main);
  if (side) node.append(el("span", { className: "c-side", textContent: side }));
  return node;
}

function showError(node: HTMLElement, message: string): false {
  node.textContent = message;
  node.hidden = false;
  return false;
}

/** Crops to the drawn content so a signature is placed without blank margins. */
function cropToInk(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 4;
  const out = el("canvas", { width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 });
  out.getContext("2d")!.drawImage(canvas, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// ---------- Signature ----------

export async function signatureDialog(): Promise<{ bytes: Uint8Array; ratio: number } | null> {
  const canvas = el("canvas", { id: "sig-canvas" });
  const typed = el("input", { type: "text", placeholder: "Type your name", dataset: { testid: "sig-typed" } });
  const typedStyle = el("select", { ariaLabel: "Signature style" },
    el("option", { value: '"Segoe Script", cursive', textContent: "Script" }),
    el("option", { value: '"Ink Free", cursive', textContent: "Handwritten" }),
    el("option", { value: 'italic "Times New Roman", serif', textContent: "Formal" }));
  const color = el("input", { type: "color", value: "#10245c", ariaLabel: "Ink colour" });
  const clear = el("button", { type: "button", textContent: "Clear", className: "secondary" });
  const remember = el("input", { type: "checkbox", checked: true });
  const upload = el("button", { type: "button", textContent: "Choose image file…", className: "secondary", dataset: { testid: "sig-upload" } });
  const uploadName = el("span", { textContent: "" });
  const error = errorLine();
  let uploaded: Uint8Array | null = null;
  const saved = readSavedSignature();

  let mode: "draw" | "type" | "upload" | "saved" = saved ? "saved" : "draw";
  const savedPreview = el("img", { alt: "Saved signature" });
  if (saved) savedPreview.src = saved;
  savedPreview.style.maxHeight = "110px";
  savedPreview.style.maxWidth = "90%";

  const ink = () => el("label", { className: "field inline" }, el("span", { textContent: "Ink" }), color);
  const inkRow = el("div", { className: "field" }, clear);
  const panes = {
    saved: el("div", { className: "sig-saved" }, savedPreview),
    draw: el("div", { className: "dlg-body" }, canvas, inkRow),
    type: el("div", { className: "dlg-body" }, field("Name", typed), field("Style", typedStyle)),
    upload: el("div", { className: "field" }, upload, uploadName),
  };
  const inkLabel = ink();
  const tabs = el("div", { className: "tabs", role: "tablist", ariaLabel: "Signature source" });
  const tabButtons = new Map<string, HTMLButtonElement>();
  const select = (next: typeof mode) => {
    mode = next;
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== next;
    for (const [key, node] of tabButtons) node.setAttribute("aria-pressed", String(key === next));
    // The ink colour applies to drawn and typed signatures, so it moves to whichever pane is showing.
    if (next === "draw") inkRow.append(inkLabel);
    if (next === "type") panes.type.append(inkLabel);
    if (next === "draw") prepareCanvas();
  };
  for (const [key, label] of [["saved", "Saved"], ["draw", "Draw"], ["type", "Type"], ["upload", "Image"]] as const) {
    if (key === "saved" && !saved) continue;
    const node = el("button", { type: "button", textContent: label, dataset: { testid: `sig-tab-${key}` }, onclick: () => select(key) });
    tabButtons.set(key, node);
    tabs.append(node);
  }

  let prepared = false;
  function prepareCanvas(): void {
    if (prepared) return;
    prepared = true;
    const box = canvas.getBoundingClientRect();
    canvas.width = box.width * 2;
    canvas.height = box.height * 2;
  }
  let drawing = false;
  const ctx = () => {
    const c = canvas.getContext("2d")!;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = 5;
    c.strokeStyle = color.value;
    return c;
  };
  const pos = (e: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [((e.clientX - box.left) / box.width) * canvas.width, ((e.clientY - box.top) / box.height) * canvas.height];
  };
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const c = ctx();
    c.beginPath();
    c.moveTo(...pos(e));
    c.lineTo(...pos(e));
    c.stroke();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const c = ctx();
    c.lineTo(...pos(e));
    c.stroke();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  clear.onclick = () => canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
  upload.onclick = async () => {
    const [file] = await window.studio.pickFiles({ title: "Choose a signature image", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] });
    if (file) {
      uploaded = file.bytes;
      uploadName.textContent = file.name;
    }
  };

  const renderTyped = (): HTMLCanvasElement | null => {
    const name = typed.value.trim();
    if (!name) return null;
    const out = el("canvas", { width: 1200, height: 300 });
    const c = out.getContext("2d")!;
    const style = typedStyle.value;
    c.font = style.startsWith("italic") ? `italic 120px ${style.slice(7)}` : `120px ${style}`;
    c.fillStyle = color.value;
    c.textBaseline = "middle";
    const width = c.measureText(name).width;
    if (width > 1160) c.font = c.font.replace("120px", `${Math.floor((120 * 1160) / width)}px`);
    c.fillText(name, 20, 150);
    return out;
  };

  let result: { bytes: Uint8Array; ratio: number } | null = null;
  const body = el("div", { className: "dlg-body" }, tabs, ...Object.values(panes), error,
    el("label", { className: "check" }, remember, "Remember this signature on this computer"),
    note("This places a picture of your signature on the page. It is not a certified digital signature."));
  const pending = showDialog<boolean>({
    title: "Add signature",
    wide: true,
    body,
    cancelValue: false,
    actions: [{ label: "Cancel", value: false }, { label: "Place on page", value: true, primary: true, testId: "sig-ok" }],
    onAction: async (ok) => {
      if (!ok) return true;
      if (mode === "upload") {
        if (!uploaded) return showError(error, "Choose an image file first.");
        const bitmap = await createImageBitmap(new Blob([uploaded as BlobPart]));
        result = { bytes: uploaded, ratio: bitmap.width / bitmap.height };
        bitmap.close();
        return true;
      }
      if (mode === "saved" && saved) {
        const img = new Image();
        img.src = saved;
        await img.decode();
        result = { bytes: dataUrlToBytes(saved), ratio: img.naturalWidth / img.naturalHeight };
        return true;
      }
      const raw = mode === "draw" ? canvas : renderTyped();
      const cropped = raw && cropToInk(raw);
      if (!cropped) return showError(error, mode === "draw" ? "Draw your signature first." : "Type your name first.");
      const url = cropped.toDataURL("image/png");
      if (remember.checked) writeSavedSignature(url);
      result = { bytes: dataUrlToBytes(url), ratio: cropped.width / cropped.height };
      return true;
    },
  });
  select(mode);
  await pending;
  return result;
}

function readSavedSignature(): string | null {
  try {
    return localStorage.getItem(SIGNATURE_KEY);
  } catch {
    return null;
  }
}

function writeSavedSignature(url: string): void {
  try {
    localStorage.setItem(SIGNATURE_KEY, url);
  } catch {
    // Remembering is a convenience; the signature is still placed.
  }
}

// ---------- Ordered file picker used by merge and images-to-PDF ----------

interface ListItem { name: string; bytes: Uint8Array; password?: string }

function fileList(items: ListItem[], kind: "pdf" | "image"): { node: HTMLElement; refresh: () => void } {
  const list = el("ol", { className: "filelist", dataset: { testid: "file-list" } });
  const refresh = () => {
    list.replaceChildren(...items.map((item, i) => {
      const tile = el("span", { className: `tile ${kind === "image" ? "img" : ""}` });
      tile.innerHTML = kind === "image" ? icons.image : icons.file;
      return el("li", {},
        el("span", { className: "idx", textContent: String(i + 1) }),
        tile,
        el("span", { className: "name", textContent: item.name, title: item.name }),
        iconButton(`Move ${item.name} up`, "up", { disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; refresh(); } }),
        iconButton(`Move ${item.name} down`, "down", { disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; refresh(); } }),
        iconButton(`Remove ${item.name}`, "close", { onclick: () => { items.splice(i, 1); refresh(); } }),
      );
    }));
  };
  refresh();
  return { node: list, refresh };
}

export async function mergeDialog(current: { name: string; bytes: Uint8Array } | null): Promise<{ path: string; bytes: Uint8Array } | null> {
  const items: ListItem[] = current ? [current] : [];
  const { node, refresh } = fileList(items, "pdf");
  const error = errorLine();
  const add = addButton("Add PDFs…", "merge-add", async () => {
    const files = await window.studio.pickFiles({ title: "Add PDFs", filters: PDF_FILTER, multi: true });
    items.push(...files.map((f) => ({ name: f.name, bytes: f.bytes })));
    refresh();
  });
  let output: { path: string; bytes: Uint8Array } | null = null;
  await showDialog<boolean>({
    title: "Merge PDFs",
    body: el("div", { className: "dlg-body" }, el("p", { textContent: "Pages are combined in this order into a new file. Open documents stay as they are." }), node, el("div", {}, add), error),
    cancelValue: false,
    actions: [{ label: "Cancel", value: false }, { label: "Merge…", value: true, primary: true, testId: "merge-ok" }],
    onAction: async (ok) => {
      if (!ok) return true;
      if (items.length < 2) return showError(error, "Add at least two PDFs to merge.");
      try {
        const bytes = await mergeWithPasswords(items);
        if (!bytes) return false;
        const path = await window.studio.pickSavePath({ title: "Save merged PDF", defaultName: "merged.pdf", filters: PDF_FILTER });
        if (!path) return false;
        await window.studio.writeFile(path, bytes.slice());
        output = { path, bytes };
        return true;
      } catch (err) {
        return showError(error, (err as Error).message);
      }
    },
  });
  return output;
}

/** Tries the merge, asking for a password each time an encrypted file blocks it. */
async function mergeWithPasswords(items: ListItem[]): Promise<Uint8Array | null> {
  for (const item of items) {
    // Probe each file so the prompt can name the one that is locked.
    let wrong = false;
    for (;;) {
      try {
        await pdf.mergePdfs([{ data: item.bytes, password: item.password }]);
        break;
      } catch (err) {
        if ((err as Error).name !== "NeedsPasswordError") throw new Error(`${item.name}: ${(err as Error).message}`);
        const password = await stackedPassword(item.name, wrong);
        if (password === null) return null;
        item.password = password;
        wrong = true;
      }
    }
  }
  return pdf.mergePdfs(items.map((i) => ({ data: i.bytes, password: i.password })));
}

/** The merge dialog is already showing, so this prompt is stacked over it. */
function stackedPassword(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el("input", { type: "password", autocomplete: "off", ariaLabel: "Password", dataset: { testid: "password-input" } });
    if (wrong) input.setAttribute("aria-invalid", "true");
    const stacked = el("dialog");
    stacked.style.width = "min(420px, 92vw)";
    const close = (value: string | null) => { stacked.close(); stacked.remove(); resolve(value); };
    const form = el("form", { onsubmit: (e: Event) => { e.preventDefault(); close(input.value); } },
      el("div", { className: "dlg-head" }, el("h2", { textContent: `${name} is protected` })),
      el("div", { className: "dlg-content" }, el("div", { className: "dlg-body" },
        el("p", { textContent: "Enter its password to include it in the merge." }),
        field("Password", input),
        ...(wrong ? [el("p", { className: "error-text", role: "alert", textContent: "That password is incorrect. Try again." })] : []))),
      el("div", { className: "dlg-actions" },
        el("button", { type: "button", textContent: "Cancel", onclick: () => close(null) }),
        el("button", { type: "submit", textContent: "Unlock", className: "primary", dataset: { testid: "password-ok" } })));
    stacked.oncancel = (e) => { e.preventDefault(); close(null); };
    stacked.append(form);
    document.body.append(stacked);
    stacked.showModal();
    input.focus();
  });
}

// ---------- Split ----------

export async function splitDialog(pageCount: number, base: string): Promise<number | null> {
  const every = el("input", { type: "number", min: "1", max: String(pageCount), value: "1", dataset: { testid: "split-every" } });
  const ranges = el("input", { type: "text", placeholder: "1-3, 4-6, 7", dataset: { testid: "split-ranges" } });
  const modeEvery = el("input", { type: "radio", name: "split-mode", checked: true });
  const modeRanges = el("input", { type: "radio", name: "split-mode", dataset: { testid: "split-mode-ranges" } });
  ranges.onfocus = () => { modeRanges.checked = true; };
  every.onfocus = () => { modeEvery.checked = true; };
  ranges.oninput = () => ranges.removeAttribute("aria-invalid");
  const error = errorLine();
  let count: number | null = null;
  const rangesBox = el("span", { className: "c-main" }, el("span", { className: "c-title" }, "By ranges", ranges), el("span", { className: "c-sub", textContent: "Separate ranges with commas. Each range becomes one file." }), error);
  const body = el("div", { className: "dlg-body" },
    el("div", { className: "choices", role: "radiogroup", ariaLabel: "How to split" },
      choice(modeEvery, ["Every", every, "page(s)"], `${pageCount} page${pageCount === 1 ? "" : "s"} in total`),
      el("label", { className: "choice" }, modeRanges, rangesBox)),
    el("p", { textContent: "You will choose a folder next. Each part becomes its own PDF. This document is not changed." }));
  await showDialog<boolean>({
    title: "Split PDF",
    body,
    cancelValue: false,
    actions: [{ label: "Cancel", value: false }, { label: "Split", value: true, primary: true, testId: "split-ok" }],
    onAction: async (ok) => {
      if (!ok) return true;
      try {
        let parts: [number, number][];
        if (modeRanges.checked) parts = parseRanges(ranges.value, pageCount);
        else {
          const n = Number(every.value);
          if (!Number.isInteger(n) || n < 1) throw new Error("Enter a whole number of pages, 1 or more.");
          parts = [];
          for (let i = 0; i < pageCount; i += n) parts.push([i, Math.min(i + n - 1, pageCount - 1)]);
        }
        const folder = await window.studio.pickFolder("Choose a folder for the split files");
        if (!folder) return false;
        const files = await pdf.split(parts);
        const width = String(files.length).length;
        for (let i = 0; i < files.length; i++) {
          await window.studio.writeInFolder(folder, `${base}_part${String(i + 1).padStart(width, "0")}.pdf`, files[i]);
        }
        count = files.length;
        return true;
      } catch (err) {
        if (modeRanges.checked) ranges.setAttribute("aria-invalid", "true");
        return showError(error, (err as Error).message);
      }
    },
  });
  return count;
}

// ---------- Images to PDF ----------

export async function imagesToPdfDialog(): Promise<{ path: string; bytes: Uint8Array } | null> {
  const items: ListItem[] = [];
  const { node, refresh } = fileList(items, "image");
  const size = el("select", { ariaLabel: "Page size" },
    el("option", { value: "image", textContent: "Same as image" }),
    el("option", { value: "a4", textContent: "A4" }),
    el("option", { value: "letter", textContent: "US Letter" }));
  const margin = el("input", { type: "number", min: "0", max: "144", value: "0" });
  const error = errorLine();
  const add = addButton("Add images…", "img-add", async () => {
    const files = await window.studio.pickFiles({ title: "Add images", multi: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff"] }] });
    items.push(...files.map((f) => ({ name: f.name, bytes: f.bytes })));
    refresh();
  });
  let output: { path: string; bytes: Uint8Array } | null = null;
  await showDialog<boolean>({
    title: "Images to PDF",
    body: el("div", { className: "dlg-body" }, el("p", { textContent: "Each image becomes one page, in this order." }), node, el("div", {}, add), field("Page size", size), field("Margin (points)", margin), error),
    cancelValue: false,
    actions: [{ label: "Cancel", value: false }, { label: "Create PDF…", value: true, primary: true, testId: "img-ok" }],
    onAction: async (ok) => {
      if (!ok) return true;
      if (!items.length) return showError(error, "Add at least one image.");
      try {
        const bytes = await pdf.imagesToPdf(items.map((i) => i.bytes), { pageSize: size.value as "image" | "a4" | "letter", margin: Math.max(0, Number(margin.value) || 0) });
        const path = await window.studio.pickSavePath({ title: "Save PDF", defaultName: "images.pdf", filters: PDF_FILTER });
        if (!path) return false;
        await window.studio.writeFile(path, bytes.slice());
        output = { path, bytes };
        return true;
      } catch (err) {
        return showError(error, (err as Error).message);
      }
    },
  });
  return output;
}

// ---------- PDF to images ----------

export async function pdfToImagesDialog(pageCount: number, base: string): Promise<number | null> {
  const pages = el("input", { type: "text", value: `1-${pageCount}`, dataset: { testid: "export-pages" } });
  const format = el("select", { ariaLabel: "Format", dataset: { testid: "export-format" } },
    el("option", { value: "png", textContent: "PNG (sharp, larger)" }),
    el("option", { value: "jpeg", textContent: "JPEG (smaller)" }));
  const dpi = el("select", { ariaLabel: "Resolution", dataset: { testid: "export-dpi" } },
    ...[72, 96, 150, 200, 300, 600].map((v) => el("option", { value: String(v), textContent: `${v} dpi`, selected: v === 150 })));
  const error = errorLine();
  let count: number | null = null;
  await showDialog<boolean>({
    title: "Export pages as images",
    body: el("div", { className: "dlg-body" }, field("Pages", pages), el("p", { className: "c-sub", textContent: `This document has ${pageCount} page${pageCount === 1 ? "" : "s"}. Use ranges like 1-3, 5.` }), field("Format", format), field("Resolution", dpi), error),
    cancelValue: false,
    actions: [{ label: "Cancel", value: false }, { label: "Export…", value: true, primary: true, testId: "export-ok" }],
    onAction: async (ok) => {
      if (!ok) return true;
      try {
        const list = rangesToPages(parseRanges(pages.value, pageCount));
        const folder = await window.studio.pickFolder("Choose a folder for the images");
        if (!folder) return false;
        const ext = format.value === "png" ? "png" : "jpg";
        const width = String(pageCount).length;
        for (const page of list) {
          const bytes = await pdf.pageToImage(page, Number(dpi.value), format.value as "png" | "jpeg");
          await window.studio.writeInFolder(folder, `${base}_page${String(page + 1).padStart(width, "0")}.${ext}`, bytes);
        }
        count = list.length;
        return true;
      } catch (err) {
        return showError(error, (err as Error).message);
      }
    },
  });
  return count;
}

// ---------- Compress ----------

export async function compressDialog(): Promise<{ info: DocInfo; result: CompressResult } | null> {
  const presets = [
    { id: "screen", label: "Smallest", sub: "For screens", dpi: 72, quality: 45 },
    { id: "ebook", label: "Balanced", sub: "For reading", dpi: 150, quality: 65 },
    { id: "print", label: "High quality", sub: "For printing", dpi: 300, quality: 85 },
  ];
  const radios = presets.map((p, i) => ({ preset: p, input: el("input", { type: "radio", name: "compress", checked: i === 1, dataset: { testid: `compress-${p.id}` } }) }));
  const error = errorLine();
  let output: { info: DocInfo; result: CompressResult } | null = null;
  await showDialog<boolean>({
    title: "Compress PDF",
    body: el("div", { className: "dlg-body" },
      el("div", { className: "choices", role: "radiogroup", ariaLabel: "Quality" }, ...radios.map((r) => choice(r.input, [r.preset.label], r.preset.sub, `${r.preset.dpi} dpi`))),
      note("Images are downsampled and fonts are reduced to the characters used. Nothing changes on disk until you save, and you can undo it."),
      error),
    cancelValue: false,
    actions: [{ label: "Cancel", value: false }, { label: "Compress", value: true, primary: true, testId: "compress-ok" }],
    onAction: async (ok) => {
      if (!ok) return true;
      const chosen = radios.find((r) => r.input.checked)!.preset;
      try {
        output = await pdf.compress(chosen.dpi, chosen.quality);
        return true;
      } catch (err) {
        return showError(error, (err as Error).message);
      }
    },
  });
  return output;
}
