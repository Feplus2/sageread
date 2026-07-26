import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 网络搜索引擎：auto=按 必应→百度→DuckDuckGo 轮询 */
export type SearchEngine = "auto" | "bing" | "baidu" | "duckduckgo";

interface WebSearchState {
  engine: SearchEngine;
  setEngine: (engine: SearchEngine) => void;
}

export const useWebSearchStore = create<WebSearchState>()(
  persist(
    (set) => ({
      engine: "auto",
      setEngine: (engine) => set({ engine }),
    }),
    {
      name: "web-search-engine",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
