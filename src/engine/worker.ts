// Runs the engine off the UI thread. Each message names an engine method or a standalone function.
import { PdfEngine, imagesToPdf, mergePdfs } from "./engine.ts";

const engine = new PdfEngine();
const standalone: Record<string, (...args: never[]) => unknown> = { imagesToPdf, mergePdfs };

function transferables(value: unknown, out: Transferable[] = []): Transferable[] {
  if (ArrayBuffer.isView(value)) out.push(value.buffer as ArrayBuffer);
  else if (Array.isArray(value)) value.forEach((item) => transferables(item, out));
  else if (value && typeof value === "object" && "pixels" in value) transferables((value as { pixels: unknown }).pixels, out);
  return out;
}

self.onmessage = (event: MessageEvent<{ id: number; method: string; args: unknown[] }>) => {
  const { id, method, args } = event.data;
  try {
    const target = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    const result = standalone[method]
      ? (standalone[method] as (...a: unknown[]) => unknown)(...args)
      : target.apply(engine, args);
    self.postMessage({ id, result }, { transfer: transferables(result) });
  } catch (err) {
    const e = err as Error;
    self.postMessage({ id, error: { name: e.name, message: e.message } });
  }
};
