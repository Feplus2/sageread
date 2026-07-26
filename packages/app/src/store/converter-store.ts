import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ConverterState {
  mineruToken: string;
  setMineruToken: (token: string) => void;
}

/**
 * PDF 转换设置。MinerU Token 存于本机 converter-store.json；
 * L1 备份白名单（backup.rs JSON_FILES）与同步通道均不含此文件，密钥不会外传。
 */
export const useConverterStore = create<ConverterState>()(
  persist(
    (set) => ({
      mineruToken: "",
      setMineruToken: (mineruToken: string) => set({ mineruToken }),
    }),
    {
      name: tauriStorageKey.converterStore,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ mineruToken: state.mineruToken }),
    },
  ),
);
