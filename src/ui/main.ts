// App controller: document lifecycle, viewer, thumbnails, tools.
import { pdf } from "./rpc.ts";
import { askPassword, el, showDialog, toast } from "./dialogs.ts";
import { compressDialog, imagesToPdfDialog, mergeDialog, pdfToImagesDialog, signatureDialog, splitDialog } from "./features.ts";
import { icons } from "./icons.ts";
import type { PickedFile } from "./global.d.ts";
import type { AnnotInfo, Color, DocInfo, PageImage, Point, Quad, Rect, TextLine } from "../engine/engine.ts";

type Tool = "select" | "text" | "image" | "signature" | "rect" | "ellipse" | "line" | "arrow" | "highlight" | "whiteout" | "edittext" | "editimage";

interface PageView {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  renderedKey: string;
  visible: boolean;
}

const PDF_FILTER = [{ name: "PDF documents", extensions: ["pdf"] }];
const IMAGE_FILTER = [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }];
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
const MAX_CANVAS_SIDE = 8000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = $<HTMLElement>("viewer");
const pagesEl = $<HTMLElement>("pages");
const thumbsEl = $<HTMLElement>("thumbs");
const statusEl = $<HTMLElement>("status-info");
const propbar = $<HTMLElement>("propbar");

const state = {
  info: null as DocInfo | null,
  filePath: null as string | null,
  fileName: "",
  zoom: 1,
  fit: "width" as "width" | "page" | null,
  tool: "select" as Tool,
  currentPage: 0,
  selectedPages: new Set<number>(),
  anchorPage: 0,
  selectedAnnot: null as { page: number; info: AnnotInfo } | null,
  selectedImage: null as { page: number; image: PageImage } | null,
  placing: null as { bytes: Uint8Array; ratio: number } | null,
  color: "#d0021b",
  fill: "",
  fontSize: 14,
  strokeWidth: 2,
  highlightColor: "#ffe600",
  search: { query: "", hits: [] as { page: number; quads: Quad[] }[], index: -1 },
  renderGeneration: 0,
};

const views: PageView[] = [];
const annotCache = new Map<number, AnnotInfo[]>();
const buttons = new Map<string, HTMLButtonElement>();

const hexToRgb = (hex: string): Color => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Color;
const rgbToCss = (c: Color) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
const norm = (a: Point, b: Point): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

// ---------- Errors and long operations ----------

let busyCount = 0;
let busyTimer = 0;
function setBusy(delta: number): void {
  busyCount += delta;
  document.body.style.cursor = busyCount > 0 ? "progress" : "";
  // Only operations that take a while show the status-bar indicator, so quick ones don't flicker.
  clearInterval(busyTimer);
  if (busyCount > 0) busyTimer = window.setInterval(() => { document.body.classList.add("busy"); showBusyBadge(); }, 400);
  else { document.body.classList.remove("busy"); showBusyBadge(); }
}

function showBusyBadge(): void {
  // While a dialog is waiting for the user, nothing is working yet.
  const working = document.body.classList.contains("busy") && !document.querySelector("dialog[open]");
  if (working === !!document.getElementById("busy-badge")) return;
  document.getElementById("busy-badge")?.remove();
  if (!working) return;
  const node = el("span", { className: "badge busy", id: "busy-badge" });
  node.innerHTML = icons.spinner;
  node.append("Working…");
  statusEl.append(node);
}

/** Every user command runs here, so a failure always reaches the user as a message. */
async function guard<T>(work: () => Promise<T>): Promise<T | undefined> {
  setBusy(1);
  try {
    return await work();
  } catch (err) {
    toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "error");
    return undefined;
  } finally {
    setBusy(-1);
  }
}

// ---------- Toolbar ----------

function button(id: string, label: string, icon: string, title: string, run: () => void, showLabel = false, className = ""): HTMLButtonElement {
  const node = el("button", { type: "button", id: `btn-${id}`, title, ariaLabel: label, onclick: run, className: className || (showLabel ? "" : "icon") });
  node.innerHTML = (icons[icon] ?? "") + (showLabel ? `<span>${label}</span>` : "");
  buttons.set(id, node);
  return node;
}

const TOOL_HUES: Record<Tool, string> = {
  select: "", text: "hue-blue", image: "hue-blue", signature: "hue-blue", rect: "hue-violet", ellipse: "hue-violet", line: "hue-violet", arrow: "hue-violet",
  highlight: "hue-amber", whiteout: "hue-coral", edittext: "hue-pink", editimage: "hue-pink",
};

function toolButton(tool: Tool, label: string, icon: string, title: string): HTMLButtonElement {
  const node = button(`tool-${tool}`, label, icon, title, () => void setTool(tool), true, `tool ${TOOL_HUES[tool]}`);
  node.setAttribute("aria-pressed", "false");
  return node;
}

const sep = () => el("span", { className: "sep" });

function buildToolbar(): void {
  const zoomSelect = el("select", { id: "zoom-select", ariaLabel: "Zoom", title: "Zoom", onchange: () => {
    const value = zoomSelect.value;
    if (value === "width" || value === "page") applyFit(value);
    else setZoom(Number(value));
  } });
  zoomSelect.append(el("option", { value: "width", textContent: "Fit width" }), el("option", { value: "page", textContent: "Fit page" }), el("option", { id: "zoom-custom", value: "custom", textContent: "100%", hidden: true }));
  for (const z of ZOOM_LEVELS) zoomSelect.append(el("option", { value: String(z), textContent: `${z * 100}%` }));

  const pageInput = el("input", { type: "text", id: "page-input", ariaLabel: "Page number", onchange: () => {
    const n = Number(pageInput.value);
    if (state.info && n >= 1 && n <= state.info.pageCount) scrollToPage(n - 1);
    else pageInput.value = String(state.currentPage + 1);
  } });

  const appMark = el("div", { id: "app-mark" });
  appMark.innerHTML = icons.doc;
  const docTool = (id: string, label: string, icon: string, title: string, run: () => void) => button(id, label, icon, title, run, true, "doc-tool");
  $("toolbar").append(
    appMark,
    button("open", "Open", "open", "Open a PDF (Ctrl+O)", () => void openCommand(), true),
    button("save", "Save", "save", "Save (Ctrl+S)", () => void saveCommand(false), true),
    button("saveas", "Save As", "saveas", "Save a copy under a new name (Ctrl+Shift+S)", () => void saveCommand(true), true),
    sep(),
    button("undo", "Undo", "undo", "Undo (Ctrl+Z)", () => void undoRedo("undo")),
    button("redo", "Redo", "redo", "Redo (Ctrl+Y)", () => void undoRedo("redo")),
    el("div", { id: "doc-title" }),
    docTool("merge", "Merge", "merge", "Combine PDFs into one file", () => void guard(mergeCommand)),
    docTool("split", "Split", "split", "Split this PDF into several files", () => void guard(splitCommand)),
    docTool("img2pdf", "Images to PDF", "img2pdf", "Create a PDF from images", () => void guard(imagesCommand)),
    docTool("pdf2img", "PDF to images", "pdf2img", "Export pages as images", () => void guard(exportImagesCommand)),
    docTool("compress", "Compress", "compress", "Make this PDF smaller", () => void guard(compressCommand)),
    sep(),
    button("find", "Find", "find", "Find in document (Ctrl+F)", () => openSearch()),
  );

  $("toolrail").append(
    toolButton("select", "Select", "select", "Select, move and resize added objects (V)"),
    sep(),
    toolButton("text", "Text", "text", "Add text (T)"),
    toolButton("image", "Image", "image", "Add an image"),
    toolButton("signature", "Sign", "sign", "Add a signature"),
    sep(),
    toolButton("rect", "Rectangle", "rect", "Draw a rectangle"),
    toolButton("ellipse", "Ellipse", "ellipse", "Draw an ellipse"),
    toolButton("line", "Line", "line", "Draw a line"),
    toolButton("arrow", "Arrow", "arrow", "Draw an arrow"),
    sep(),
    toolButton("highlight", "Highlight", "highlight", "Highlight text by dragging across it (H)"),
    toolButton("whiteout", "Whiteout", "whiteout", "Remove the text and images under an area from the file (W)"),
    sep(),
    toolButton("edittext", "Edit text", "edittext", "Click a line of text to change it (E)"),
    toolButton("editimage", "Edit image", "editimage", "Click an image to replace or delete it"),
  );

  $("status-controls").append(
    button("prev", "Previous page", "up", "Previous page (Page Up)", () => scrollToPage(state.currentPage - 1)),
    button("next", "Next page", "down", "Next page (Page Down)", () => scrollToPage(state.currentPage + 1)),
    pageInput,
    el("span", { id: "page-total" }),
    sep(),
    button("zoomout", "Zoom out", "minus", "Zoom out (Ctrl+-)", () => stepZoom(-1)),
    zoomSelect,
    button("zoomin", "Zoom in", "plus", "Zoom in (Ctrl+=)", () => stepZoom(1)),
    sep(),
    button("fitwidth", "Fit width", "fitw", "Fit width (Ctrl+0)", () => applyFit("width")),
    button("fitpage", "Fit page", "fitp", "Fit page", () => applyFit("page")),
  );

  const fill = (id: string, icon: string) => { $(id).innerHTML = icons[icon]; };
  fill("search-icon", "find");
  fill("search-prev", "up");
  fill("search-next", "down");
  fill("search-close", "close");
  fill("readonly-icon", "lock");
  fill("empty-icon", "doc");
  fill("drop-icon", "drop");

  $("panel-actions").append(
    button("page-rotl", "Rotate left", "rotl", "Rotate selected pages left", () => void rotateSelected(-90)),
    button("page-rotr", "Rotate right", "rotr", "Rotate selected pages right", () => void rotateSelected(90)),
    button("page-up", "Move up", "moveup", "Move selected pages up", () => void moveSelected(-1)),
    button("page-down", "Move down", "movedown", "Move selected pages down", () => void moveSelected(1)),
    button("page-delete", "Delete pages", "trash", "Delete selected pages", () => void deleteSelected()),
    button("page-extract", "Extract pages", "extract", "Save selected pages as a new PDF", () => void guard(extractSelected)),
  );

  const startButton = (label: string, icon: string, run: () => void, primary = false, key = "") => {
    const node = el("button", { type: "button", className: primary ? "primary" : "secondary", onclick: run });
    node.innerHTML = icons[icon];
    node.append(label);
    if (key) node.append(el("span", { className: "key", textContent: key }));
    return node;
  };
  $("empty-actions").append(
    startButton("Open a PDF", "open", () => void openCommand(), true, "Ctrl+O"),
    startButton("Merge PDFs", "merge", () => void guard(mergeCommand)),
    startButton("Images to PDF", "img2pdf", () => void guard(imagesCommand)),
  );
}

function refreshChrome(): void {
  const info = state.info;
  const has = !!info;
  const editable = has && info!.canEdit;
  const dirty = has && info!.dirty;
  document.title = has ? `${dirty ? "* " : ""}${state.fileName} - Pagewright` : "Pagewright";
  window.studio.setDirty(dirty);
  $("readonly").hidden = !has || info!.canEdit;
  $("empty").hidden = has;
  const enable = (id: string, on: boolean) => { const b = buttons.get(id); if (b) b.disabled = !on; };
  enable("save", has);
  enable("saveas", has);
  enable("undo", editable && info!.canUndo);
  enable("redo", editable && info!.canRedo);
  for (const t of ["text", "image", "signature", "rect", "ellipse", "line", "arrow", "highlight", "whiteout", "edittext", "editimage"]) enable(`tool-${t}`, editable);
  enable("tool-select", has);
  for (const b of ["split", "pdf2img", "find", "prev", "next", "zoomin", "zoomout", "fitwidth", "fitpage"]) enable(b, has);
  if (has) {
    enable("prev", state.currentPage > 0);
    enable("next", state.currentPage < info!.pageCount - 1);
  }
  enable("compress", editable);
  const anySelected = has && state.selectedPages.size > 0;
  enable("page-rotl", editable && anySelected);
  enable("page-rotr", editable && anySelected);
  enable("page-up", editable && anySelected);
  enable("page-down", editable && anySelected);
  enable("page-delete", editable && anySelected);
  enable("page-extract", anySelected);
  $<HTMLSelectElement>("zoom-select").disabled = !has;
  $<HTMLInputElement>("page-input").disabled = !has;
  $<HTMLInputElement>("page-input").value = has ? String(state.currentPage + 1) : "";
  $("page-total").textContent = has ? `of ${info!.pageCount}` : "";
  $("panel").hidden = !has;
  $("status-controls").hidden = !has;
  $("panel-count").textContent = has ? `${state.selectedPages.size} selected` : "";

  const title = $("doc-title");
  title.replaceChildren(el("span", { className: "name", textContent: has ? state.fileName : "Pagewright" }));
  if (dirty) title.append(el("span", { className: "dirty", title: "Unsaved changes" }));
  if (has) title.append(el("span", { className: "app", textContent: "— Pagewright" }));

  const badge = (label: string, icon: string, kind = "") => {
    const node = el("span", { className: `badge ${kind}` });
    node.innerHTML = icons[icon];
    node.append(label);
    return node;
  };
  statusEl.replaceChildren();
  if (has) {
    statusEl.append(el("span", { className: "file", textContent: state.fileName }), el("span", { textContent: `${info!.pageCount} page${info!.pageCount === 1 ? "" : "s"}` }));
    if (info!.encrypted) statusEl.append(badge("Password protected", "lock"));
    if (!info!.canEdit) statusEl.append(badge("Read-only", "lock"));
    if (dirty) statusEl.append(badge("Unsaved changes", "alert", "warn"));
  } else {
    statusEl.append(el("span", { textContent: "No document open" }));
  }
  showBusyBadge();
}

// ---------- Open, save, unsaved changes ----------

/** Returns false if the user cancelled, so the caller must stop. */
async function confirmDiscard(): Promise<boolean> {
  if (!state.info?.dirty) return true;
  const choice = await showDialog<"save" | "discard" | "cancel">({
    title: `Save changes to ${state.fileName}?`,
    body: el("p", { textContent: "You have unsaved changes. If you don't save, they will be lost." }),
    cancelValue: "cancel",
    actions: [
      { label: "Save", value: "save", primary: true },
      { label: "Don't save", value: "discard", danger: true, testId: "discard" },
      { label: "Cancel", value: "cancel" },
    ],
  });
  if (choice === "cancel") return false;
  if (choice === "save") return saveCommand(false);
  return true;
}

async function openCommand(): Promise<void> {
  await guard(async () => {
    if (!(await confirmDiscard())) return;
    const [file] = await window.studio.pickFiles({ title: "Open PDF", filters: PDF_FILTER });
    if (file) await openFile(file);
  });
}

async function openFile(file: PickedFile): Promise<void> {
  const result = await openWithPassword(file.bytes, file.name);
  if (!result) return;
  state.filePath = file.path || null;
  state.fileName = file.name;
  documentOpened(result);
}

async function openWithPassword(bytes: Uint8Array, name: string): Promise<DocInfo | null> {
  // The worker copies bytes, so the same buffer can be retried with another password.
  let res = await pdf.open(bytes);
  while (res.status === "needs-password") {
    const password = await askPassword(name, res.wrongPassword);
    if (password === null) return null;
    res = await pdf.open(bytes, password);
  }
  return res.info;
}

function documentOpened(info: DocInfo): void {
  state.info = info;
  state.currentPage = 0;
  state.selectedPages = new Set();
  state.anchorPage = 0;
  clearSelection();
  closeSearch();
  state.placing = null;
  state.fit = "width";
  state.tool = "select";
  rebuildPages();
  applyFit("width");
  void setTool("select");
  refreshChrome();
  viewer.scrollTop = 0;
}

/** Saves the current document. Returns true only when the bytes reached the disk. */
async function saveCommand(saveAs: boolean): Promise<boolean> {
  if (!state.info) return false;
  commitInlineEditor();
  const saved = await guard(async () => {
    let target = state.filePath;
    if (saveAs || !target) {
      target = await window.studio.pickSavePath({ title: "Save PDF", defaultName: state.fileName || "document.pdf", filters: PDF_FILTER });
      if (!target) return false;
    }
    const bytes = await pdf.saveVerified();
    await window.studio.writeFile(target, bytes);
    state.filePath = target;
    state.fileName = target.split(/[\\/]/).pop()!;
    state.info = await pdf.markSaved();
    refreshChrome();
    toast(`Saved ${state.fileName}`);
    return true;
  });
  return saved === true;
}

/** Applies an edit result: updates history state, redraws the affected pages. */
async function applyEdit(work: () => Promise<DocInfo | null>, pages?: number[]): Promise<void> {
  await guard(async () => {
    const info = await work();
    if (!info) return;
    afterChange(info, pages);
  });
}

function afterChange(info: DocInfo, pages?: number[]): void {
  const structureChanged = !state.info || info.pageCount !== state.info.pageCount
    || info.pages.some((p, i) => p.width !== state.info!.pages[i].width || p.height !== state.info!.pages[i].height);
  state.info = info;
  clearSelection();
  if (structureChanged) {
    state.currentPage = Math.min(state.currentPage, info.pageCount - 1);
    state.selectedPages = new Set([...state.selectedPages].filter((p) => p < info.pageCount));
    rebuildPages();
  }
  invalidate(pages);
  refreshChrome();
  if (state.search.query) void runSearch(state.search.query, true);
}

async function undoRedo(which: "undo" | "redo"): Promise<void> {
  commitInlineEditor();
  if (!state.info?.canEdit) return;
  await applyEdit(() => (which === "undo" ? pdf.undo() : pdf.redo()));
}

// ---------- Pages and rendering ----------

function rebuildPages(): void {
  state.renderGeneration++;
  pageObserver.disconnect();
  thumbObserver.disconnect();
  pagesEl.replaceChildren();
  thumbsEl.replaceChildren();
  views.length = 0;
  annotCache.clear();
  const info = state.info;
  if (!info) return;
  info.pages.forEach((_p, index) => {
    const canvas = el("canvas");
    const overlay = el("div", { className: "overlay", dataset: { page: String(index) } });
    const wrap = el("div", { className: "page", dataset: { page: String(index), testid: `page-${index}` } }, canvas, overlay);
    pagesEl.append(wrap);
    views.push({ wrap, canvas, overlay, renderedKey: "", visible: false });
    pageObserver.observe(wrap);
    thumbsEl.append(buildThumb(index));
  });
  layoutPages();
  updateThumbSelection();
  applyToolClasses();
}

function layoutPages(): void {
  state.info?.pages.forEach((p, i) => {
    views[i].wrap.style.width = `${p.width * state.zoom}px`;
    views[i].wrap.style.height = `${p.height * state.zoom}px`;
  });
  redrawOverlays();
}

/** Mark pages as stale (all when omitted), and redraw the ones on screen. */
function invalidate(pages?: number[]): void {
  state.renderGeneration++;
  const list = pages ?? views.map((_v, i) => i);
  for (const i of list) {
    if (!views[i]) continue;
    views[i].renderedKey = "";
    annotCache.delete(i);
    thumbCanvasDirty(i);
  }
  for (let i = 0; i < views.length; i++) if (views[i].visible) void renderPage(i);
  redrawOverlays();
}

const pageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const index = Number((entry.target as HTMLElement).dataset.page);
    const view = views[index];
    if (!view) continue;
    view.visible = entry.isIntersecting;
    if (view.visible) void renderPage(index);
  }
  updateCurrentPage();
}, { root: viewer, rootMargin: "400px" });

async function renderPage(index: number): Promise<void> {
  const view = views[index];
  const info = state.info;
  if (!view || !info) return;
  const dpr = window.devicePixelRatio || 1;
  const page = info.pages[index];
  const longest = Math.max(page.width, page.height);
  const scale = Math.min(state.zoom * dpr, MAX_CANVAS_SIDE / longest);
  const key = `${scale}`;
  if (view.renderedKey === key) return;
  view.renderedKey = key;
  const generation = state.renderGeneration;
  try {
    const [result, annots] = await Promise.all([pdf.render(index, scale), pdf.annotations(index)]);
    annotCache.set(index, annots);
    if (generation !== state.renderGeneration || views[index] !== view) return;
    if (view.renderedKey !== key) return;
    view.canvas.width = result.width;
    view.canvas.height = result.height;
    view.canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
    view.wrap.dataset.rendered = "true";
    drawOverlay(index);
  } catch (err) {
    if (generation === state.renderGeneration) {
      view.renderedKey = "";
      toast(`Page ${index + 1} could not be displayed. ${(err as Error).message}`, "error");
    }
  }
}

function setZoom(zoom: number, anchor?: { x: number; y: number }): void {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const ax = anchor?.x ?? viewer.clientWidth / 2;
  const ay = anchor?.y ?? viewer.clientHeight / 2;
  const ratio = next / state.zoom;
  const left = (viewer.scrollLeft + ax) * ratio - ax;
  const top = (viewer.scrollTop + ay) * ratio - ay;
  state.zoom = next;
  state.fit = null;
  layoutPages();
  viewer.scrollLeft = left;
  viewer.scrollTop = top;
  syncZoomSelect();
  rerenderVisible();
}

function applyFit(mode: "width" | "page"): void {
  const info = state.info;
  state.fit = mode;
  if (info) {
    const page = info.pages[state.currentPage] ?? info.pages[0];
    const availW = viewer.clientWidth - 48;
    const availH = viewer.clientHeight - 40;
    const zoom = mode === "width" ? availW / Math.max(...info.pages.map((p) => p.width)) : Math.min(availW / page.width, availH / page.height);
    state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    layoutPages();
    rerenderVisible();
    if (mode === "page") scrollToPage(state.currentPage);
  }
  syncZoomSelect();
}

function stepZoom(direction: 1 | -1): void {
  const next = direction > 0 ? ZOOM_LEVELS.find((z) => z > state.zoom + 0.001) : [...ZOOM_LEVELS].reverse().find((z) => z < state.zoom - 0.001);
  if (next) setZoom(next);
}

function syncZoomSelect(): void {
  const select = $<HTMLSelectElement>("zoom-select");
  const custom = $<HTMLOptionElement>("zoom-custom");
  if (state.fit) {
    select.value = state.fit;
    custom.hidden = true;
  } else if (ZOOM_LEVELS.includes(state.zoom)) {
    select.value = String(state.zoom);
    custom.hidden = true;
  } else {
    custom.textContent = `${Math.round(state.zoom * 100)}%`;
    custom.hidden = false;
    select.value = "custom";
  }
  select.dataset.zoom = String(state.zoom);
}

let rerenderTimer = 0;
function rerenderVisible(): void {
  clearTimeout(rerenderTimer);
  rerenderTimer = window.setTimeout(() => {
    views.forEach((view, i) => { if (view.visible) void renderPage(i); });
  }, 60);
}

function scrollToPage(index: number): void {
  const view = views[index];
  if (!view) return;
  viewer.scrollTop = view.wrap.offsetTop - 12;
  state.currentPage = index;
  refreshChrome();
  highlightCurrentThumb();
}

function updateCurrentPage(): void {
  if (!views.length) return;
  const mid = viewer.scrollTop + viewer.clientHeight / 2;
  let best = 0;
  for (let i = 0; i < views.length; i++) {
    if (views[i].wrap.offsetTop <= mid) best = i;
    else break;
  }
  if (best !== state.currentPage) {
    state.currentPage = best;
    $<HTMLInputElement>("page-input").value = String(best + 1);
    if (state.info) {
      buttons.get("prev")!.disabled = best === 0;
      buttons.get("next")!.disabled = best >= state.info.pageCount - 1;
    }
    highlightCurrentThumb();
  }
}

viewer.addEventListener("scroll", updateCurrentPage, { passive: true });
viewer.addEventListener("wheel", (event) => {
  if (!event.ctrlKey || !state.info) return;
  event.preventDefault();
  const box = viewer.getBoundingClientRect();
  setZoom(state.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: event.clientX - box.left, y: event.clientY - box.top });
}, { passive: false });
new ResizeObserver(() => { if (state.fit && state.info) applyFit(state.fit); }).observe(viewer);

// ---------- Thumbnails ----------

const thumbDirty = new Set<number>();
const THUMB_WIDTH = 140;

function buildThumb(index: number): HTMLElement {
  const page = state.info!.pages[index];
  const scale = THUMB_WIDTH / Math.max(page.width, page.height * 0.8);
  const canvas = el("canvas");
  canvas.style.width = `${page.width * scale}px`;
  canvas.style.height = `${page.height * scale}px`;
  const thumb = el("div", { className: "thumb", role: "option", tabIndex: 0, draggable: true, dataset: { page: String(index), testid: `thumb-${index}` } },
    canvas, el("div", { className: "num", textContent: String(index + 1) }));
  thumb.setAttribute("aria-label", `Page ${index + 1}`);
  thumb.addEventListener("click", (event) => selectThumb(index, event));
  thumb.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectThumb(index, event); } });
  thumb.addEventListener("dragstart", (event) => {
    if (!state.info?.canEdit) { event.preventDefault(); return; }
    if (!state.selectedPages.has(index)) {
      state.selectedPages = new Set([index]);
      updateThumbSelection();
    }
    event.dataTransfer!.setData("application/x-pagewright-pages", "1");
    event.dataTransfer!.effectAllowed = "move";
  });
  thumb.addEventListener("dragover", (event) => {
    if (!event.dataTransfer!.types.includes("application/x-pagewright-pages")) return;
    event.preventDefault();
    const box = thumb.getBoundingClientRect();
    const before = event.clientY < box.top + box.height / 2;
    thumb.classList.toggle("drop-before", before);
    thumb.classList.toggle("drop-after", !before);
  });
  thumb.addEventListener("dragleave", () => thumb.classList.remove("drop-before", "drop-after"));
  thumb.addEventListener("drop", (event) => {
    if (!event.dataTransfer!.types.includes("application/x-pagewright-pages")) return;
    event.preventDefault();
    event.stopPropagation();
    const before = thumb.classList.contains("drop-before");
    thumb.classList.remove("drop-before", "drop-after");
    void moveSelectedTo(before ? index : index + 1);
  });
  thumbDirty.add(index);
  thumbObserver.observe(thumb);
  return thumb;
}

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) void renderThumb(Number((entry.target as HTMLElement).dataset.page));
  }
}, { root: thumbsEl, rootMargin: "200px" });

function thumbCanvasDirty(index: number): void {
  thumbDirty.add(index);
  const thumb = thumbsEl.children[index] as HTMLElement | undefined;
  if (!thumb) return;
  const box = thumb.getBoundingClientRect();
  const area = thumbsEl.getBoundingClientRect();
  if (box.bottom > area.top - 200 && box.top < area.bottom + 200) void renderThumb(index);
}

async function renderThumb(index: number): Promise<void> {
  if (!thumbDirty.has(index) || !state.info) return;
  thumbDirty.delete(index);
  const generation = state.renderGeneration;
  const thumb = thumbsEl.children[index] as HTMLElement | undefined;
  const canvas = thumb?.querySelector("canvas");
  if (!canvas) return;
  const page = state.info.pages[index];
  const dpr = window.devicePixelRatio || 1;
  const scale = (parseFloat(canvas.style.width) / page.width) * dpr;
  try {
    const result = await pdf.render(index, scale);
    if (generation !== state.renderGeneration && thumbDirty.has(index)) return;
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
  } catch {
    thumbDirty.add(index);
  }
}

function selectThumb(index: number, event: MouseEvent | KeyboardEvent): void {
  if (event.shiftKey) {
    const [a, b] = [Math.min(state.anchorPage, index), Math.max(state.anchorPage, index)];
    state.selectedPages = new Set(Array.from({ length: b - a + 1 }, (_v, i) => a + i));
  } else if (event.ctrlKey) {
    if (state.selectedPages.has(index)) state.selectedPages.delete(index);
    else state.selectedPages.add(index);
    state.anchorPage = index;
  } else {
    state.selectedPages = new Set([index]);
    state.anchorPage = index;
  }
  updateThumbSelection();
  scrollToPage(index);
}

function updateThumbSelection(): void {
  [...thumbsEl.children].forEach((node, i) => node.setAttribute("aria-selected", String(state.selectedPages.has(i))));
  $("panel-count").textContent = state.info ? `${state.selectedPages.size} selected` : "";
  highlightCurrentThumb();
  refreshChrome();
}

function highlightCurrentThumb(): void {
  [...thumbsEl.children].forEach((node, i) => node.classList.toggle("current", i === state.currentPage));
}

const selectedList = () => [...state.selectedPages].sort((a, b) => a - b);

async function rotateSelected(degrees: 90 | -90): Promise<void> {
  const pages = selectedList();
  await applyEdit(() => pdf.rotatePages(pages, degrees));
}

async function deleteSelected(): Promise<void> {
  const pages = selectedList();
  await applyEdit(async () => {
    const info = await pdf.deletePages(pages);
    state.selectedPages = new Set();
    return info;
  });
}

/** Moves the selected block so it starts before the page that was at `target`. */
async function moveSelectedTo(target: number): Promise<void> {
  const selected = selectedList();
  const count = state.info!.pageCount;
  const others = Array.from({ length: count }, (_v, i) => i).filter((i) => !state.selectedPages.has(i));
  const insertAt = others.filter((i) => i < target).length;
  const order = [...others.slice(0, insertAt), ...selected, ...others.slice(insertAt)];
  if (order.every((v, i) => v === i)) return;
  await applyEdit(async () => {
    const info = await pdf.reorderPages(order);
    state.selectedPages = new Set(selected.map((_p, i) => insertAt + i));
    return info;
  });
  rebuildThumbs();
}

function rebuildThumbs(): void {
  thumbObserver.disconnect();
  thumbsEl.replaceChildren();
  state.info?.pages.forEach((_p, i) => thumbsEl.append(buildThumb(i)));
  updateThumbSelection();
}

async function moveSelected(direction: -1 | 1): Promise<void> {
  const selected = selectedList();
  if (direction < 0 && selected[0] === 0) return;
  if (direction > 0 && selected[selected.length - 1] === state.info!.pageCount - 1) return;
  await moveSelectedTo(direction < 0 ? selected[0] - 1 : selected[selected.length - 1] + 2);
}

async function extractSelected(): Promise<void> {
  const pages = selectedList();
  const target = await window.studio.pickSavePath({
    title: "Save extracted pages",
    defaultName: `${baseName()}_pages.pdf`,
    filters: PDF_FILTER,
  });
  if (!target) return;
  await window.studio.writeFile(target, await pdf.extractPages(pages));
  toast(`Extracted ${pages.length} page${pages.length === 1 ? "" : "s"}`, "info", { label: "Show file", run: () => void window.studio.reveal(target) });
}

const baseName = () => state.fileName.replace(/\.pdf$/i, "") || "document";

// ---------- Tools ----------

async function setTool(tool: Tool): Promise<void> {
  commitInlineEditor();
  clearSelection();
  state.placing = null;
  if (tool === "image" || tool === "signature") {
    const placing = tool === "image" ? await pickImageToPlace() : await signatureDialog();
    if (!placing) {
      if (state.tool === tool) state.tool = "select";
      updateToolUi();
      return;
    }
    state.placing = placing;
  }
  state.tool = tool;
  updateToolUi();
}

function updateToolUi(): void {
  for (const [id, node] of buttons) if (id.startsWith("tool-")) node.setAttribute("aria-pressed", String(id === `tool-${state.tool}`));
  applyToolClasses();
  buildPropbar();
  redrawOverlays();
}

async function pickImageToPlace(): Promise<{ bytes: Uint8Array; ratio: number } | null> {
  const [file] = await window.studio.pickFiles({ title: "Choose an image", filters: IMAGE_FILTER });
  if (!file) return null;
  return { bytes: file.bytes, ratio: await imageRatio(file.bytes) };
}

async function imageRatio(bytes: Uint8Array): Promise<number> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const ratio = bitmap.width / bitmap.height;
    bitmap.close();
    return ratio;
  } catch {
    return 1;
  }
}

const HINTS: Partial<Record<Tool, string>> = {
  select: "Click an added object to select it. Drag to move, drag a corner to resize, Delete removes it. Double-click added text to retype.",
  text: "Click where the text should go, then type.",
  image: "Click to place the image, or drag to set its size.",
  signature: "Click to place the signature, or drag to set its size.",
  rect: "Drag to draw.",
  ellipse: "Drag to draw.",
  line: "Drag to draw.",
  arrow: "Drag to draw.",
  highlight: "Drag across text to highlight it.",
  whiteout: "Drag over an area. The text and images under it are removed from the file, not just covered.",
  edittext: "Click a line of text to edit it in place. Enter saves, Esc cancels. Clear the line to delete it.",
  editimage: "Click an image to replace or delete it.",
};

const TOOL_NAMES: Record<Tool, [string, string, string]> = {
  select: ["Select", "select", "V"], text: ["Text", "text", "T"], image: ["Image", "image", ""], signature: ["Sign", "sign", ""],
  rect: ["Rectangle", "rect", ""], ellipse: ["Ellipse", "ellipse", ""], line: ["Line", "line", ""], arrow: ["Arrow", "arrow", ""],
  highlight: ["Highlight", "highlight", "H"], whiteout: ["Whiteout", "whiteout", "W"], edittext: ["Edit text", "edittext", "E"], editimage: ["Edit image", "editimage", ""],
};

function buildPropbar(): void {
  propbar.replaceChildren();
  const tool = state.tool;
  propbar.hidden = !state.info;
  const [name, icon, key] = TOOL_NAMES[tool];
  const chip = el("div", { className: `prop-tool tool-chip ${TOOL_HUES[tool]}` });
  chip.innerHTML = icons[icon];
  chip.append(name);
  if (key) chip.append(el("kbd", { textContent: key }));
  const hint = el("span", { id: "hint", textContent: state.info && !state.info.canEdit ? "Editing is turned off for this PDF." : HINTS[tool] ?? "" });
  propbar.append(chip, el("span", { className: "sep" }));
  if (tool === "whiteout") {
    const warn = el("span", { className: "prop-warn" });
    warn.innerHTML = icons.warn;
    propbar.append(warn);
    hint.classList.add("warn");
  }
  propbar.append(hint);
  const options = el("div", { className: "prop-options" });
  const colorInput = (label: string, value: string, set: (v: string) => void) =>
    el("label", {}, label, el("input", { type: "color", value, ariaLabel: label, oninput: (e: Event) => set((e.target as HTMLInputElement).value) }));
  if (tool === "text") {
    const size = el("input", { type: "number", min: "6", max: "144", value: String(state.fontSize), id: "prop-size", onchange: () => { state.fontSize = clampNum(size.value, 6, 144, 14); size.value = String(state.fontSize); } });
    options.append(colorInput("Colour", state.color, (v) => { state.color = v; }), el("label", {}, "Size", size));
  }
  if (["rect", "ellipse", "line", "arrow"].includes(tool)) {
    const width = el("input", { type: "number", min: "0.5", max: "40", step: "0.5", value: String(state.strokeWidth), onchange: () => { state.strokeWidth = clampNum(width.value, 0.5, 40, 2); width.value = String(state.strokeWidth); } });
    options.append(colorInput("Colour", state.color, (v) => { state.color = v; }), el("label", {}, "Width", width));
    if (tool === "rect" || tool === "ellipse") {
      const fillOn = el("input", { type: "checkbox", checked: !!state.fill, onchange: () => { state.fill = fillOn.checked ? fillColor.value : ""; } });
      const fillColor = el("input", { type: "color", value: state.fill || "#ffffff", ariaLabel: "Fill colour", oninput: () => { if (fillOn.checked) state.fill = fillColor.value; } });
      options.append(el("label", {}, fillOn, "Fill", fillColor));
    }
  }
  if (tool === "highlight") options.append(colorInput("Colour", state.highlightColor, (v) => { state.highlightColor = v; }));
  if (tool === "select") {
    const flatten = el("button", { type: "button", innerHTML: icons.layers + "<span>Flatten objects</span>", id: "btn-flatten", title: "Make all added objects a permanent part of their pages", disabled: !state.info?.canEdit, onclick: () => void applyEdit(() => pdf.flatten()) });
    options.append(flatten);
  }
  if (options.childElementCount) propbar.append(options);
}

function clampNum(value: string, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function applyToolClasses(): void {
  const draw = ["text", "image", "signature", "rect", "ellipse", "line", "arrow", "highlight", "whiteout"].includes(state.tool);
  views.forEach((view) => {
    view.overlay.classList.toggle("draw", draw);
    view.overlay.classList.toggle("edit-text", state.tool === "edittext");
  });
}

function pagePoint(view: PageView, event: PointerEvent | MouseEvent): Point {
  const box = view.overlay.getBoundingClientRect();
  return [(event.clientX - box.left) / state.zoom, (event.clientY - box.top) / state.zoom];
}

function placeEl(node: HTMLElement, r: Rect): HTMLElement {
  const z = state.zoom;
  Object.assign(node.style, { left: `${r[0] * z}px`, top: `${r[1] * z}px`, width: `${(r[2] - r[0]) * z}px`, height: `${(r[3] - r[1]) * z}px` });
  return node;
}

pagesEl.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  const overlay = target.closest<HTMLElement>(".overlay");
  if (!overlay || !state.info || event.button !== 0) return;
  if (target.closest(".inline-edit, .img-menu")) return;
  if (inlineEditor) {
    commitInlineEditor();
    return;
  }
  const index = Number(overlay.dataset.page);
  const view = views[index];
  const start = pagePoint(view, event);
  switch (state.tool) {
    case "select": return startSelect(index, view, start, event);
    case "text": return startTextPlacement(index, start);
    case "image":
    case "signature": return startDrag(index, view, start, event, "preview", (a, b, dragged) => placeImage(index, a, b, dragged));
    case "rect":
    case "ellipse":
    case "line":
    case "arrow": return startDrag(index, view, start, event, state.tool === "line" || state.tool === "arrow" ? "line" : "preview", (a, b, dragged) => dragged ? addShape(index, a, b) : undefined);
    case "whiteout": return startDrag(index, view, start, event, "white", (a, b, dragged) => dragged ? applyEdit(() => pdf.whiteout(index, norm(a, b)), [index]) : undefined);
    case "highlight": return startHighlight(index, view, start, event);
    default: return undefined;
  }
});

// Without this, the mouse-down that opens an inline editor would immediately take focus back from it.
pagesEl.addEventListener("mousedown", (event) => {
  if (!(event.target as HTMLElement).closest(".inline-edit, .img-menu")) event.preventDefault();
});

/** Generic rubber-band drag. Calls done with the two corner points. */
function startDrag(index: number, view: PageView, start: Point, event: PointerEvent, style: "preview" | "white" | "line", done: (a: Point, b: Point, dragged: boolean) => unknown): void {
  const preview = el("div", { className: `preview ${style === "white" ? "white" : ""}` });
  view.overlay.append(preview);
  placeEl(preview, [...start, ...start] as Rect);
  const overlay = view.overlay;
  overlay.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => placeEl(preview, norm(start, pagePoint(view, e)));
  const up = (e: PointerEvent) => {
    overlay.removeEventListener("pointermove", move);
    overlay.removeEventListener("pointerup", up);
    overlay.removeEventListener("pointercancel", cancel);
    preview.remove();
    const end = clampToPage(index, pagePoint(view, e));
    const dragged = Math.hypot(end[0] - start[0], end[1] - start[1]) * state.zoom > 4;
    void done(start, end, dragged);
  };
  const cancel = () => {
    overlay.removeEventListener("pointermove", move);
    overlay.removeEventListener("pointerup", up);
    overlay.removeEventListener("pointercancel", cancel);
    preview.remove();
  };
  overlay.addEventListener("pointermove", move);
  overlay.addEventListener("pointerup", up);
  overlay.addEventListener("pointercancel", cancel);
}

function clampToPage(index: number, p: Point): Point {
  const page = state.info!.pages[index];
  return [Math.min(page.width, Math.max(0, p[0])), Math.min(page.height, Math.max(0, p[1]))];
}

async function addShape(index: number, a: Point, b: Point): Promise<void> {
  const kind = state.tool as "rect" | "ellipse" | "line" | "arrow";
  const args = {
    kind,
    rect: norm(a, b),
    line: [a, b] as [Point, Point],
    color: hexToRgb(state.color),
    fill: state.fill ? hexToRgb(state.fill) : null,
    width: state.strokeWidth,
  };
  await applyEdit(() => pdf.addShape(index, args), [index]);
}

async function placeImage(index: number, a: Point, b: Point, dragged: boolean): Promise<void> {
  const placing = state.placing;
  if (!placing) return;
  const page = state.info!.pages[index];
  let width = dragged ? Math.abs(b[0] - a[0]) : Math.min(180, page.width / 2);
  let height = width / placing.ratio;
  if (dragged && Math.abs(b[1] - a[1]) < height) {
    height = Math.abs(b[1] - a[1]) || height;
    width = height * placing.ratio;
  }
  const x = Math.max(0, Math.min(page.width - width, Math.min(a[0], dragged ? b[0] : a[0])));
  const y = Math.max(0, Math.min(page.height - height, Math.min(a[1], dragged ? b[1] : a[1])));
  await applyEdit(() => pdf.addImage(index, [x, y, x + width, y + height], placing.bytes.slice()), [index]);
  state.placing = null;
  state.tool = "select";
  updateToolUi();
}

function startHighlight(index: number, view: PageView, start: Point, event: PointerEvent): void {
  const overlay = view.overlay;
  overlay.setPointerCapture(event.pointerId);
  const layer = el("div");
  overlay.append(layer);
  const color = hexToRgb(state.highlightColor);
  let latest: Point = start;
  let inFlight = false;
  const refresh = async () => {
    if (inFlight) return;
    inFlight = true;
    const asked = latest;
    const quads = await pdf.selectionQuads(index, start, asked).catch(() => [] as Quad[]);
    inFlight = false;
    layer.replaceChildren(...quads.map((q) => quadEl(q, "quad")));
    if (asked !== latest) void refresh();
  };
  const move = (e: PointerEvent) => { latest = pagePoint(view, e); void refresh(); };
  const up = (e: PointerEvent) => {
    overlay.removeEventListener("pointermove", move);
    overlay.removeEventListener("pointerup", up);
    layer.remove();
    const end = pagePoint(view, e);
    void applyEdit(async () => {
      const info = await pdf.addHighlight(index, start, end, color);
      if (!info) toast("No text there to highlight. Drag across some text.");
      return info;
    }, [index]);
  };
  overlay.addEventListener("pointermove", move);
  overlay.addEventListener("pointerup", up);
}

function quadEl(q: Quad, className: string): HTMLElement {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return placeEl(el("div", { className }), [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

// ---------- Select, move, resize added objects ----------

function clearSelection(): void {
  state.selectedAnnot = null;
  state.selectedImage = null;
  document.querySelectorAll(".sel-box, .img-menu").forEach((n) => n.remove());
}

const DOUBLE_CLICK_MS = 450;
let lastSelectClick = { id: -1, time: 0 };

function startSelect(index: number, view: PageView, start: Point, event: PointerEvent): void {
  const annots = annotCache.get(index) ?? [];
  const hit = [...annots].reverse().find((a) => start[0] >= a.rect[0] - 3 && start[0] <= a.rect[2] + 3 && start[1] >= a.rect[1] - 3 && start[1] <= a.rect[3] + 3);
  clearSelection();
  if (!hit) return;
  state.selectedAnnot = { page: index, info: hit };
  drawSelection();
  // Tracked by hand: the selection box is replaced between clicks, so the browser's dblclick never fires.
  const now = performance.now();
  const isDouble = hit.kind === "text" && lastSelectClick.id === hit.id && now - lastSelectClick.time < DOUBLE_CLICK_MS;
  lastSelectClick = { id: hit.id, time: now };
  if (isDouble) {
    openAnnotTextEditor(index, hit);
    return;
  }
  beginTransform(index, view, hit, start, event, null);
}

function drawSelection(): void {
  document.querySelectorAll(".sel-box").forEach((n) => n.remove());
  const sel = state.selectedAnnot;
  if (!sel) return;
  const view = views[sel.page];
  if (!view) return;
  const box = placeEl(el("div", { className: "sel-box", dataset: { testid: "sel-box" } }), sel.info.rect);
  const resizable = ["text", "image", "rect", "ellipse"].includes(sel.info.kind);
  if (resizable) {
    for (const h of ["nw", "ne", "sw", "se"]) {
      const handle = el("div", { className: "handle", dataset: { h } });
      handle.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        beginTransform(sel.page, view, sel.info, pagePoint(view, event), event, h);
      });
      box.append(handle);
    }
  }
  view.overlay.append(box);
}

function beginTransform(index: number, view: PageView, info: AnnotInfo, start: Point, event: PointerEvent, handle: string | null): void {
  if (info.kind === "other") return;
  const overlay = view.overlay;
  overlay.setPointerCapture(event.pointerId);
  let rect = info.rect;
  const compute = (p: Point): Rect => {
    const [dx, dy] = [p[0] - start[0], p[1] - start[1]];
    const [x0, y0, x1, y1] = info.rect;
    if (!handle) return [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
    let r: Rect = [handle.includes("w") ? x0 + dx : x0, handle.includes("n") ? y0 + dy : y0, handle.includes("e") ? x1 + dx : x1, handle.includes("s") ? y1 + dy : y1];
    if (info.kind === "image") {
      // Images keep their aspect ratio while resizing.
      const ratio = (x1 - x0) / (y1 - y0);
      const width = Math.max(8, Math.abs(r[2] - r[0]));
      const height = width / ratio;
      r = [handle.includes("w") ? x1 - width : x0, handle.includes("n") ? y1 - height : y0, handle.includes("w") ? x1 : x0 + width, handle.includes("n") ? y1 : y0 + height];
    }
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  };
  const box = overlay.querySelector<HTMLElement>(".sel-box");
  const move = (e: PointerEvent) => {
    rect = compute(pagePoint(view, e));
    if (box) placeEl(box, rect);
  };
  const up = (e: PointerEvent) => {
    overlay.removeEventListener("pointermove", move);
    overlay.removeEventListener("pointerup", up);
    const moved = Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) > 3;
    if (!moved) return;
    const [dx, dy] = [rect[0] - info.rect[0], rect[1] - info.rect[1]];
    const line = info.line?.map((p) => [p[0] + dx, p[1] + dy]) as [Point, Point] | undefined;
    const id = info.id;
    void (async () => {
      await applyEdit(() => pdf.moveAnnotation(index, id, rect, line), [index]);
      const annots = await pdf.annotations(index);
      annotCache.set(index, annots);
      const again = annots.find((a) => a.id === id);
      if (again) {
        state.selectedAnnot = { page: index, info: again };
        drawSelection();
      }
    })();
  };
  overlay.addEventListener("pointermove", move);
  overlay.addEventListener("pointerup", up);
}

async function deleteSelection(): Promise<void> {
  const annot = state.selectedAnnot;
  if (annot) {
    await applyEdit(() => pdf.deleteAnnotation(annot.page, annot.info.id), [annot.page]);
    return;
  }
  const image = state.selectedImage;
  if (image) await applyEdit(() => pdf.deleteImage(image.page, image.image.index), [image.page]);
}

// ---------- Inline text editors ----------

let inlineEditor: { commit: () => void } | null = null;

function commitInlineEditor(): void {
  inlineEditor?.commit();
}

/** Shared inline editor. Enter commits unless multiline, where Ctrl+Enter does. Esc cancels. */
function openInlineEditor(index: number, options: {
  rect: Rect; text: string; fontSize: number; color: string; multiline: boolean;
  fontFamily?: string; fontWeight?: string; fontStyle?: string;
  onCommit: (text: string) => void;
}): void {
  commitInlineEditor();
  const view = views[index];
  const z = state.zoom;
  const input = el("textarea", { className: "inline-edit", value: options.text, spellcheck: false, dataset: { testid: "inline-edit" } });
  input.setAttribute("aria-label", "Edit text");
  Object.assign(input.style, {
    left: `${options.rect[0] * z}px`,
    top: `${options.rect[1] * z}px`,
    fontSize: `${options.fontSize * z}px`,
    fontFamily: options.fontFamily ?? "Arial, Helvetica, sans-serif",
    fontWeight: options.fontWeight ?? "normal",
    fontStyle: options.fontStyle ?? "normal",
    color: options.color,
  });
  const resize = () => {
    const lines = input.value.split("\n");
    input.style.height = `${Math.max(options.rect[3] - options.rect[1], lines.length * options.fontSize * 1.2 + 4) * z}px`;
    input.style.width = "10px";
    input.style.width = `${Math.max((options.rect[2] - options.rect[0]) * z, input.scrollWidth + options.fontSize * z)}px`;
  };
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    inlineEditor = null;
    const value = input.value;
    input.remove();
    if (commit) options.onCommit(value);
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") finish(false);
    if (event.key === "Enter" && (!options.multiline || event.ctrlKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  input.addEventListener("input", resize);
  input.addEventListener("blur", () => finish(true));
  inlineEditor = { commit: () => finish(true) };
  view.overlay.append(input);
  resize();
  input.focus();
  input.select();
}

function startTextPlacement(index: number, at: Point): void {
  const size = state.fontSize;
  const color = state.color;
  const page = state.info!.pages[index];
  const x = Math.min(at[0], page.width - 40);
  const y = Math.min(at[1], page.height - size * 1.4);
  openInlineEditor(index, {
    rect: [x, y, x + 160, y + size * 1.3],
    text: "",
    fontSize: size,
    color,
    multiline: true,
    onCommit: (text) => {
      if (!text.trim()) return;
      void applyEdit(() => pdf.addText(index, { rect: textRect(x, y, text, size, page.width), text, fontSize: size, color: hexToRgb(color) }), [index]);
    },
  });
}

const measureCtx = document.createElement("canvas").getContext("2d")!;

/** A FreeText box sized to its text, so the words do not wrap or clip. */
function textRect(x: number, y: number, text: string, size: number, pageWidth: number): Rect {
  measureCtx.font = `${size}px Arial, Helvetica, sans-serif`;
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => measureCtx.measureText(l).width));
  const right = Math.min(pageWidth, x + width + size + 8);
  return [x, y, right, y + lines.length * size * 1.25 + size * 0.6];
}

function openAnnotTextEditor(index: number, info: AnnotInfo): void {
  clearSelection();
  const size = info.fontSize ?? 12;
  openInlineEditor(index, {
    rect: info.rect,
    text: info.text ?? "",
    fontSize: size,
    color: info.color ? rgbToCss(info.color) : "#000",
    multiline: true,
    onCommit: (text) => {
      if (text === info.text) return;
      if (!text.trim()) void applyEdit(() => pdf.deleteAnnotation(index, info.id), [index]);
      else void applyEdit(() => pdf.updateAnnotationText(index, info.id, text), [index]);
    },
  });
}

const CSS_FONTS = { Helvetica: "Arial, Helvetica, sans-serif", Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };

function openLineEditor(index: number, line: TextLine): void {
  openInlineEditor(index, {
    rect: line.bbox,
    text: line.text,
    fontSize: line.size,
    color: rgbToCss(line.color),
    multiline: false,
    fontFamily: CSS_FONTS[line.font.family],
    fontWeight: line.font.bold ? "bold" : "normal",
    fontStyle: line.font.italic ? "italic" : "normal",
    onCommit: (text) => {
      if (text === line.text) return;
      const { origin, size, color, font, dir } = line;
      void applyEdit(async () => {
        const info = await pdf.replaceTextLine(index, line.bbox, { origin, size, color, font, dir }, text);
        if (info.fontFallback) toast("This PDF's font doesn't contain all of those characters, so the closest standard font was used.");
        return info;
      }, [index]);
    },
  });
}

// ---------- Overlays for edit tools and search ----------

let overlayGeneration = 0;

function redrawOverlays(): void {
  overlayGeneration++;
  views.forEach((_v, i) => drawOverlay(i));
  drawSelection();
}

function drawOverlay(index: number): void {
  const view = views[index];
  if (!view) return;
  view.overlay.querySelectorAll(".hit, .line-box, .img-box, .img-menu").forEach((n) => n.remove());
  const { hits, index: current } = state.search;
  hits.forEach((hit, i) => {
    if (hit.page !== index) return;
    hit.quads.forEach((q) => view.overlay.append(quadEl(q, `hit${i === current ? " current" : ""}`)));
  });
  if (!view.visible) return;
  if (state.tool === "edittext") void drawLineBoxes(index, view).catch(ignoreIfStale);
  if (state.tool === "editimage") void drawImageBoxes(index, view).catch(ignoreIfStale);
}

/** A page can disappear while its boxes load, which is harmless. Anything else is reported. */
function ignoreIfStale(err: Error): void {
  if (!/invalid page number|No document/.test(err.message)) toast(err.message, "error");
}

async function drawLineBoxes(index: number, view: PageView): Promise<void> {
  const generation = overlayGeneration;
  const lines = await pdf.textLines(index);
  if (generation !== overlayGeneration || state.tool !== "edittext") return;
  view.overlay.querySelectorAll(".line-box").forEach((n) => n.remove());
  for (const line of lines) {
    const box = placeEl(el("div", { className: "line-box", title: line.text, dataset: { testid: "line-box" } }), line.bbox);
    box.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openLineEditor(index, line);
    });
    view.overlay.append(box);
  }
}

async function drawImageBoxes(index: number, view: PageView): Promise<void> {
  const generation = overlayGeneration;
  const images = await pdf.pageImages(index);
  if (generation !== overlayGeneration || state.tool !== "editimage") return;
  view.overlay.querySelectorAll(".img-box, .img-menu").forEach((n) => n.remove());
  for (const image of images) {
    const box = placeEl(el("div", { className: "img-box", title: `${image.width} x ${image.height} pixels`, dataset: { testid: "img-box" } }), image.bbox);
    box.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectImage(index, view, image, box);
    });
    view.overlay.append(box);
  }
}

function selectImage(index: number, view: PageView, image: PageImage, box: HTMLElement): void {
  view.overlay.querySelectorAll(".img-menu").forEach((n) => n.remove());
  document.querySelectorAll(".img-box.selected").forEach((n) => n.classList.remove("selected"));
  box.classList.add("selected");
  state.selectedImage = { page: index, image };
  const replace = el("button", { type: "button", innerHTML: icons.image + "<span>Replace…</span>", dataset: { testid: "img-replace" }, onclick: async () => {
    const [file] = await window.studio.pickFiles({ title: "Choose the new image", filters: IMAGE_FILTER });
    if (file) await applyEdit(() => pdf.replaceImage(index, image.index, file.bytes), [index]);
  } });
  const remove = el("button", { type: "button", innerHTML: icons.trash + "<span>Delete</span>", className: "danger", dataset: { testid: "img-delete" }, onclick: () => void applyEdit(() => pdf.deleteImage(index, image.index), [index]) });
  const menu = el("div", { className: "img-menu" }, replace, remove);
  menu.style.left = `${image.bbox[0] * state.zoom}px`;
  menu.style.top = `${Math.max(0, image.bbox[1] * state.zoom - 40)}px`;
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  view.overlay.append(menu);
}

// ---------- Search ----------

function openSearch(): void {
  if (!state.info) return;
  $("searchbar").hidden = false;
  buttons.get("find")?.setAttribute("aria-pressed", "true");
  const input = $<HTMLInputElement>("search-input");
  input.focus();
  input.select();
}

function closeSearch(): void {
  $("searchbar").hidden = true;
  buttons.get("find")?.setAttribute("aria-pressed", "false");
  state.search = { query: "", hits: [], index: -1 };
  $("search-count").textContent = "";
  redrawOverlays();
}

async function runSearch(query: string, keepPosition = false): Promise<void> {
  const previous = state.search.index;
  const hits = query ? await pdf.search(query) : [];
  state.search = { query, hits, index: hits.length ? (keepPosition ? Math.min(Math.max(previous, 0), hits.length - 1) : 0) : -1 };
  updateSearchUi(!keepPosition);
}

function updateSearchUi(scroll: boolean): void {
  const { hits, index, query } = state.search;
  $("search-count").textContent = !query ? "" : hits.length ? `${index + 1} of ${hits.length}` : "No matches";
  redrawOverlays();
  if (scroll && index >= 0) scrollToHit(index);
}

function scrollToHit(i: number): void {
  const hit = state.search.hits[i];
  const view = views[hit.page];
  if (!view) return;
  const y = Math.min(hit.quads[0][1], hit.quads[0][3]) * state.zoom;
  viewer.scrollTop = view.wrap.offsetTop + y - viewer.clientHeight / 3;
}

function stepSearch(direction: 1 | -1): void {
  const { hits, index } = state.search;
  if (!hits.length) return;
  state.search.index = (index + direction + hits.length) % hits.length;
  updateSearchUi(true);
}

let searchTimer = 0;
$<HTMLInputElement>("search-input").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const query = (event.target as HTMLInputElement).value;
  searchTimer = window.setTimeout(() => void guard(() => runSearch(query)), 160);
});
$<HTMLInputElement>("search-input").addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Enter") stepSearch(event.shiftKey ? -1 : 1);
  if (event.key === "Escape") closeSearch();
});
$("search-next").onclick = () => stepSearch(1);
$("search-prev").onclick = () => stepSearch(-1);
$("search-close").onclick = () => closeSearch();

// ---------- Feature commands ----------

async function offerToOpen(path: string, bytes: Uint8Array, message: string): Promise<void> {
  toast(message, "info", { label: "Open", run: () => void guard(async () => {
    if (await confirmDiscard()) await openFile({ path, name: path.split(/[\\/]/).pop()!, bytes });
  }) });
}

async function mergeCommand(): Promise<void> {
  const current = state.info ? { name: state.fileName, bytes: await pdf.save() } : null;
  const result = await mergeDialog(current);
  if (result) await offerToOpen(result.path, result.bytes, "Merged PDF saved.");
}

async function splitCommand(): Promise<void> {
  const count = await splitDialog(state.info!.pageCount, baseName());
  if (count) toast(`Created ${count} PDF file${count === 1 ? "" : "s"}.`);
}

async function imagesCommand(): Promise<void> {
  const result = await imagesToPdfDialog();
  if (result) await offerToOpen(result.path, result.bytes, "PDF created from images.");
}

async function exportImagesCommand(): Promise<void> {
  const count = await pdfToImagesDialog(state.info!.pageCount, baseName());
  if (count) toast(`Exported ${count} image${count === 1 ? "" : "s"}.`);
}

async function compressCommand(): Promise<void> {
  const outcome = await compressDialog();
  if (!outcome) return;
  afterChange(outcome.info);
  const { before, after } = outcome.result;
  const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
  const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  const message = after < before ? `Reduced from ${mb(before)} to ${mb(after)}, ${saved}% smaller. Save to keep it.` : `This PDF is already compact (${mb(after)}). Nothing more could be removed.`;
  toast(message);
  const status = el("span", { id: "compress-result", textContent: message });
  statusEl.append(status);
}

$("unlock").onclick = () => void guard(async () => {
  let wrong = false;
  for (;;) {
    const password = await askPassword(state.fileName, wrong, "Enter the owner password to allow editing.");
    if (password === null) return;
    if (await pdf.unlockEditing(password)) break;
    wrong = true;
  }
  state.info = await pdf.info();
  refreshChrome();
  buildPropbar();
});

// ---------- Keyboard, drop, window events ----------

document.addEventListener("keydown", (event) => {
  const typing = (event.target as HTMLElement).matches?.("input, textarea, select");
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if ((document.getElementById("dialog") as HTMLDialogElement).open) return;
  if (ctrl) {
    const actions: Record<string, () => void> = {
      o: () => void openCommand(),
      s: () => void saveCommand(event.shiftKey),
      z: () => void undoRedo(event.shiftKey ? "redo" : "undo"),
      y: () => void undoRedo("redo"),
      f: () => openSearch(),
      "=": () => stepZoom(1),
      "+": () => stepZoom(1),
      "-": () => stepZoom(-1),
      "0": () => applyFit("width"),
    };
    if (actions[key] && !(typing && "zy".includes(key))) {
      event.preventDefault();
      actions[key]();
    }
    return;
  }
  if (typing || !state.info) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    if (state.selectedAnnot || state.selectedImage) void deleteSelection();
    return;
  }
  if (event.key === "Escape") {
    clearSelection();
    if (state.tool !== "select") void setTool("select");
    return;
  }
  const canEdit = state.info.canEdit;
  const shortcuts: Record<string, Tool> = { v: "select", t: "text", h: "highlight", w: "whiteout", e: "edittext" };
  if (shortcuts[key] && (canEdit || key === "v")) void setTool(shortcuts[key]);
  if (event.key === "PageDown") { event.preventDefault(); scrollToPage(state.currentPage + 1); }
  if (event.key === "PageUp") { event.preventDefault(); scrollToPage(state.currentPage - 1); }
});

viewer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  viewer.classList.add("dropping");
});
viewer.addEventListener("dragleave", () => viewer.classList.remove("dropping"));
viewer.addEventListener("drop", (event) => {
  event.preventDefault();
  viewer.classList.remove("dropping");
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  void guard(async () => {
    if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("Only PDF files can be dropped here.");
    if (!(await confirmDiscard())) return;
    const path = (await window.studio.approveDropped(file)) ?? "";
    await openFile({ path, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  });
});
// A file dropped outside the viewer must not navigate the window away.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

window.studio.onSaveAndClose(() => {
  void saveCommand(false).then((saved) => { if (saved) window.studio.closeNow(); });
});
window.studio.onOpenFile((file) => void guard(() => openFile(file)));

buildToolbar();
updateToolUi();
refreshChrome();
syncZoomSelect();
window.studio.ready();
