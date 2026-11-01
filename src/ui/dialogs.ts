// Small modal helpers built on <dialog>.
import { icons } from "./icons.ts";

const dialogEl = document.getElementById("dialog") as HTMLDialogElement;
const MAX_TOASTS = 3;

export interface DialogAction<T> { label: string; value: T; primary?: boolean; danger?: boolean; testId?: string }

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

/**
 * Shows a modal and resolves with the chosen action's value. Esc resolves to cancelValue.
 * onAction may return false to keep the dialog open, for example after a validation error.
 */
export function showDialog<T>(options: {
  title: string;
  body?: HTMLElement;
  actions: DialogAction<T>[];
  cancelValue: T;
  onAction?: (value: T) => boolean | Promise<boolean>;
  wide?: boolean;
}): Promise<T> {
  return new Promise((resolve) => {
    dialogEl.replaceChildren();
    dialogEl.classList.toggle("wide", !!options.wide);
    const finish = (value: T) => {
      dialogEl.oncancel = null;
      dialogEl.close();
      resolve(value);
    };
    const buttons = options.actions.map((action) => {
      const button = el("button", { type: "button", textContent: action.label, className: action.primary ? "primary" : action.danger ? "danger" : "" });
      if (action.testId) button.dataset.testid = action.testId;
      button.onclick = async () => {
        if (options.onAction && !(await options.onAction(action.value))) return;
        finish(action.value);
      };
      return button;
    });
    dialogEl.oncancel = (event) => {
      event.preventDefault();
      finish(options.cancelValue);
    };
    const form = el("form", { method: "dialog", onsubmit: (event: Event) => {
      event.preventDefault();
      buttons[options.actions.findIndex((a) => a.primary)]?.click();
    } });
    const close = el("button", { type: "button", className: "dlg-close", title: "Close (Esc)", ariaLabel: "Close", onclick: () => finish(options.cancelValue) });
    close.innerHTML = icons.close;
    form.append(el("div", { className: "dlg-head" }, el("h2", { textContent: options.title }), close));
    form.append(el("div", { className: "dlg-content" }, ...(options.body ? [options.body] : [])));
    form.append(el("div", { className: "dlg-actions" }, ...buttons));
    dialogEl.append(form);
    dialogEl.showModal();
  });
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { className: "field" }, el("span", { textContent: label }), control);
}

/** Asks for a PDF password. Resolves to null if cancelled. */
export function askPassword(fileName: string, wrong: boolean, message?: string): Promise<string | null> {
  const input = el("input", { type: "password", autocomplete: "off", ariaLabel: "Password" });
  input.dataset.testid = "password-input";
  if (wrong) input.setAttribute("aria-invalid", "true");
  const body = el("div", { className: "dlg-body" },
    el("p", { textContent: message ?? `"${fileName}" is protected. Enter its password to open it.` }),
    field("Password", input));
  if (wrong) body.append(el("p", { className: "error-text", role: "alert", textContent: "That password is incorrect. Try again." }));
  const result = showDialog<string | null>({
    title: "Password required",
    body,
    cancelValue: null,
    actions: [
      { label: "Cancel", value: null },
      { label: message ? "Unlock" : "Open", value: "ok", primary: true, testId: "password-ok" },
    ],
  }).then((value) => (value === null ? null : input.value));
  input.focus();
  return result;
}

export function toast(message: string, kind: "info" | "error" = "info", action?: { label: string; run: () => void }): void {
  const node = el("div", { className: `toast ${kind}`, role: kind === "error" ? "alert" : "status" });
  node.innerHTML = kind === "error" ? icons.alert : icons.check;
  node.append(el("span", { className: "msg", textContent: message }));
  if (action) node.append(el("button", { type: "button", className: "act", textContent: action.label, onclick: () => { action.run(); node.remove(); } }));
  const dismiss = el("button", { type: "button", className: "dismiss", title: "Dismiss", ariaLabel: "Dismiss", onclick: () => node.remove() });
  dismiss.innerHTML = icons.close;
  node.append(dismiss);
  const toasts = document.getElementById("toasts")!;
  toasts.append(node);
  while (toasts.children.length > MAX_TOASTS) toasts.firstElementChild!.remove();
  setTimeout(() => node.remove(), kind === "error" ? 9000 : action ? 8000 : 3500);
}
