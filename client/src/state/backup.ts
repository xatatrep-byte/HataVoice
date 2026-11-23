import { create } from "zustand";

/** «Сохрани копию личности»: shown once the owner has just claimed a server. */
export const useBackupPrompt = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
