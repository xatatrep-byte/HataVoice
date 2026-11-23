import { useEffect } from "react";
import { create } from "zustand";

export type Toast = { id: string; kind: "info" | "error"; text: string };

type ToastState = {
  toasts: Toast[];
  /** Shows a notification; an identical visible one is reused. Returns its id. */
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
};

/** Info notifications hide on their own; errors stay until dismissed. */
export const INFO_TOAST_MS = 5000;

let counter = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ kind, text }) => {
    const existing = get().toasts.find((t) => t.kind === kind && t.text === text);
    if (existing) return existing.id;
    const id = `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    if (kind === "info") setTimeout(() => get().dismiss(id), INFO_TOAST_MS);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const notify = {
  info: (text: string) => useToasts.getState().push({ kind: "info", text }),
  error: (text: string) => useToasts.getState().push({ kind: "error", text }),
};

/** Shows `text` as an error notification while it is the current problem; it goes away once the problem is over. */
export function useErrorToast(text: string | null) {
  useEffect(() => {
    if (!text) return;
    const id = notify.error(text);
    return () => useToasts.getState().dismiss(id);
  }, [text]);
}
