import { create } from "zustand";

export type PreviewFormat = "html" | "svg" | "mermaid" | "react";

export interface PreviewItem {
  id: string;
  content: string;
  language: string;
  format: PreviewFormat;
  title: string;
}

interface PreviewState {
  item: PreviewItem | null;
  isOpen: boolean;
  openPreview: (item: PreviewItem) => void;
  closePreview: () => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  item: null,
  isOpen: false,
  openPreview: (item) => set({ item, isOpen: true }),
  closePreview: () => set({ isOpen: false }),
}));
