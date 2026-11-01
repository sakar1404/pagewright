import type { PdfEngine, imagesToPdf, mergePdfs } from "../engine/engine.ts";

type Methods = {
  [K in keyof PdfEngine]: PdfEngine[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<R> : never;
} & {
  imagesToPdf: (...a: Parameters<typeof imagesToPdf>) => Promise<Uint8Array>;
  mergePdfs: (...a: Parameters<typeof mergePdfs>) => Promise<Uint8Array>;
};

const worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

worker.onmessage = (event) => {
  const { id, result, error } = event.data;
  const call = pending.get(id);
  if (!call) return;
  pending.delete(id);
  if (error) {
    const err = new Error(error.message);
    err.name = error.name;
    call.reject(err);
  } else call.resolve(result);
};

/** Typed proxy: pdf.addText(...) posts to the worker and resolves with its result. */
export const pdf = new Proxy({} as Methods, {
  get: (_target, method: string) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }),
});
