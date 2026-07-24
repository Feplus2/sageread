import { markProgrammaticNavigation, msSinceUserNavigation } from "@/pages/reader/hooks/navigation-tracker";
import { getBookStatus } from "@/services/book-service";
import type { SyncRunResult } from "@/services/sync-service";
import { reapplyCurrentBackground } from "@/services/ui-config-sync";
import { useFontStore } from "@/store/font-store";
import { useLayoutStore } from "@/store/layout-store";
import { useLibraryStore } from "@/store/library-store";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/** 防跳动保护窗口：60 秒内用户刚翻过页则只提示不跳转 */
const ANTI_JUMP_WINDOW_MS = 60_000;

/**
 * 同步落地：把一轮 L2 同步结果应用到 UI
 * - 按变更标记刷新查询缓存（threads / annotations / notes）与书架
 * - 把远端进度应用到当前打开的书（见 applyProgressToOpenBooks）
 */
export async function applySyncResult(result: SyncRunResult, queryClient: QueryClient): Promise<void> {
  if (result.thread_ids.length > 0) {
    queryClient.invalidateQueries({ queryKey: ["threads"] });
  }
  if (result.notes_changed) {
    queryClient.invalidateQueries({ queryKey: ["annotations"] });
    queryClient.invalidateQueries({ queryKey: ["notes"] });
  }
  if (result.books_changed) {
    void useLibraryStore.getState().refreshBooks();
  }

  // 资产下载联动：刷新字体列表；重解析当前背景 fileUrl + 通知设置面板刷新背景列表
  if (result.fonts_downloaded > 0) {
    void useFontStore.getState().refreshFonts();
  }
  if (result.backgrounds_downloaded > 0) {
    void reapplyCurrentBackground();
    window.dispatchEvent(new CustomEvent("reader-backgrounds-updated"));
  }

  await applyProgressToOpenBooks(result.book_status_ids);
}

/**
 * 把远端进度应用到当前打开的书（60 秒防跳动保护）
 * 同时更新 reader store 缓存的 config.location：恢复位置的真实来源是它（initBook 时从 book_status 派生），
 * 不更新的话后续 saveBookConfig 会把陈旧位置回写、覆盖同步结果（"未打开的书下次打开仍从旧位置恢复"的根因）
 */
async function applyProgressToOpenBooks(bookIds: string[]) {
  if (bookIds.length === 0) return;

  const { tabs, getReaderStore } = useLayoutStore.getState();
  for (const tab of tabs) {
    if (!bookIds.includes(tab.bookId)) continue;

    const store = getReaderStore(tab.id);
    if (!store) continue;

    try {
      const status = await getBookStatus(tab.bookId);
      if (!status?.location) continue;

      const state = store.getState();

      // 更新缓存 config.location（其余字段不动；location 为空时跳过）
      if (state.config && state.config.location !== status.location) {
        state.setConfig({ ...state.config, location: status.location });
      }

      const view = state.view;
      if (!view) continue;

      const percent = status.progressTotal > 0 ? Math.round((status.progressCurrent / status.progressTotal) * 100) : 0;
      if (msSinceUserNavigation(tab.bookId) < ANTI_JUMP_WINDOW_MS) {
        toast.info(`另一台设备进度已到 ${percent}%，刷新后生效`);
      } else {
        // 标记程序化跳转：这次 goTo 引起的位置变化不算用户翻页，避免污染防跳动保护
        markProgrammaticNavigation(tab.bookId);
        view.goTo(status.location);
        toast.info(`已同步另一台设备的进度（第 ${percent}%）`);
      }
    } catch (error) {
      console.warn("应用远端进度失败:", error);
    }
  }
}
