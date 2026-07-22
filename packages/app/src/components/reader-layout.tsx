import HomeLayout from "@/components/home-layout";
import { NotepadContainer } from "@/components/notepad";
import NotificationDropdown from "@/components/notification-dropdown";
import SettingsDialog from "@/components/settings/settings-dialog";
import SideChat from "@/components/side-chat";
import WindowControls from "@/components/window-controls";
import { useFontEvents } from "@/hooks/use-font-events";
import ReaderViewer from "@/pages/reader";
import { ReaderProvider } from "@/pages/reader/components/reader-provider";
import { msSinceUserNavigation } from "@/pages/reader/hooks/navigation-tracker";
import { getBookStatus } from "@/services/book-service";
import {
  type SyncRunResult,
  syncBackupNow,
  syncGetConfig,
  syncHasUnpushed,
  syncPullNow,
  syncRunNow,
} from "@/services/sync-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import { getOSPlatform } from "@/utils/misc";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs } from "app-tabs";
import { HomeIcon } from "lucide-react";
import { Resizable } from "re-resizable";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 同步落地：把远端进度应用到当前打开的书（防跳动保护——60 秒内用户刚翻过页则只提示不跳转）
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
      if (msSinceUserNavigation(tab.bookId) < 60_000) {
        toast.info(`另一台设备进度已到 ${percent}%，刷新后生效`);
      } else {
        view.goTo(status.location);
        toast.info(`已同步另一台设备的进度（第 ${percent}%）`);
      }
    } catch (error) {
      console.warn("应用远端进度失败:", error);
    }
  }
}

export default function ReaderLayout() {
  useFontEvents();
  const {
    tabs,
    activeTabId,
    isHomeActive,

    removeTab,
    activateTab,
    navigateToHome,
    getReaderStore,
    isChatVisible,
    isNotepadVisible,
  } = useLayoutStore();
  const { isDarkMode, swapSidebars } = useThemeStore();
  const { isSettingsDialogOpen, toggleSettingsDialog } = useAppSettingsStore();
  const queryClient = useQueryClient();

  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);

  const isWindows = getOSPlatform() === "windows";

  // 启动时应用持久化的全局主题（值来自 localStorage 同步读取，无异步恢复闪烁）
  useEffect(() => {
    const { refreshGlobalThemes, setGlobalTheme, globalTheme } = useThemeStore.getState();
    refreshGlobalThemes().then(() => {
      if (globalTheme) {
        setGlobalTheme(globalTheme);
      }
    });
  }, []);

  // WebDAV 自动备份：按配置的频率 setInterval（关闭/每小时/每天）
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const setup = async () => {
      try {
        const config = await syncGetConfig();
        if (cancelled || !config || config.auto_backup === "off" || !config.endpoint) return;
        const intervalMs = config.auto_backup === "hourly" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        timer = setInterval(() => {
          syncBackupNow().catch((error) => console.warn("自动备份失败:", error));
        }, intervalMs);
      } catch (error) {
        console.warn("自动备份初始化失败:", error);
      }
    };

    setup();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // L2 增量同步调度（P1 修复）：
  // 固定 25 秒基础 tick——dirty 立即完整同步（推+拉，不受频率下拉影响）；
  // clean 时按 sync_frequency 兜底轻量拉取（syncPullNow：远端无新意时只有一个小 GET，无变更零下载）。
  // 启动时自动一轮照旧。
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient 实例稳定，定时器只需注册一次
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let syncing = false;
    let lastPullAt = 0;

    const handleResult = (result: SyncRunResult) => {
      if (result.thread_ids.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["threads"] });
      }
      // 拉到当前打开书的进度：跳转或提示（60 秒防跳动保护在 applyProgressToOpenBooks 内）
      void applyProgressToOpenBooks(result.book_status_ids);
    };

    const runWith = (fn: () => Promise<SyncRunResult>) => {
      if (syncing) return;
      syncing = true;
      fn()
        .then(handleResult)
        .catch((error) => console.warn("L2 同步失败:", error))
        .finally(() => {
          syncing = false;
        });
    };

    const setup = async () => {
      try {
        const config = await syncGetConfig();
        if (cancelled || !config || !config.l2_enabled || !config.endpoint) return;

        // 启动自动一轮完整同步
        runWith(syncRunNow);
        lastPullAt = Date.now();

        // clean 时的拉取兜底频率：下拉仅控制它（off = 不兜底，只能靠推送轮顺带拉取）
        const pullFallbackMs =
          config.sync_frequency === "30min"
            ? 30 * 60_000
            : config.sync_frequency === "5min"
              ? 5 * 60_000
              : config.sync_frequency === "off"
                ? Number.POSITIVE_INFINITY
                : 30_000;

        timer = setInterval(() => {
          syncHasUnpushed()
            .then((dirty) => {
              if (dirty) {
                runWith(syncRunNow); // 有变更：立即推+拉
                lastPullAt = Date.now();
              } else if (Date.now() - lastPullAt >= pullFallbackMs) {
                runWith(syncPullNow); // 无变更：按兜底频率轻量拉取
                lastPullAt = Date.now();
              }
            })
            .catch((error) => console.warn("L2 水位检查失败:", error));
        }, 25_000);
      } catch (error) {
        console.warn("L2 同步调度初始化失败:", error);
      }
    };

    setup();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setShowOverlay(true);

      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = setTimeout(() => {
        setShowOverlay(false);
      }, 200);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCloseShortcut =
        (event.metaKey && event.key === "w" && event.code === "KeyW") ||
        (event.ctrlKey && event.key === "w" && event.code === "KeyW");

      if (isCloseShortcut) {
        event.preventDefault();
        if (activeTabId && activeTabId !== "home") {
          removeTab(activeTabId);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTabId, removeTab]);

  return (
    <div className="flex h-screen flex-col bg-muted">
      <div
        data-region="reader-tabs"
        className="select-none border-neutral-200 dark:border-neutral-700 dark:bg-tab-background"
      >
        <Tabs
          tabs={tabs}
          onTabActive={activateTab}
          onTabClose={removeTab}
          onTabReorder={() => {}}
          draggable={true}
          darkMode={isDarkMode}
          className="h-7"
          enableDragRegion={true}
          marginLeft={isWindows ? 0 : 60}
          pinnedLeft={
            <div className="mx-2 flex items-center gap-2" onClick={navigateToHome}>
              <HomeIcon className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
            </div>
          }
          pinnedRight={
            <div className="flex items-center gap-1">
              <NotificationDropdown />
              <WindowControls />
            </div>
          }
        />
      </div>

      <main className="relative flex-1 overflow-hidden rounded-md">
        <div
          className="absolute inset-0"
          style={{
            visibility: isHomeActive ? "visible" : "hidden",
            zIndex: isHomeActive ? 1 : 0,
          }}
        >
          <HomeLayout />
        </div>

        {tabs.map((tab) => {
          const store = getReaderStore(tab.id);
          if (!store) return null;

          const notepadSidebar = isNotepadVisible && (
            <Resizable
              defaultSize={{
                width: 300,
                height: "100%",
              }}
              minWidth={260}
              maxWidth={500}
              enable={{
                top: false,
                right: !swapSidebars,
                bottom: false,
                left: swapSidebars,
                topRight: false,
                bottomRight: false,
                bottomLeft: false,
                topLeft: false,
              }}
              handleComponent={
                swapSidebars
                  ? { left: <div className="custom-resize-handle" /> }
                  : { right: <div className="custom-resize-handle custom-resize-handle-left" /> }
              }
              className="h-full"
              onResize={() => {
                if (!showOverlay) {
                  setShowOverlay(true);
                }
              }}
              onResizeStop={() => {
                setShowOverlay(false);
                window.dispatchEvent(
                  new CustomEvent("foliate-resize-update", {
                    detail: { bookId: tab.bookId, source: "resize-drag" },
                  }),
                );
              }}
            >
              <div
                data-region="notepad-panel"
                className={swapSidebars ? "ml-1 h-[calc(100dvh-48px)]" : "mr-1 h-[calc(100dvh-48px)]"}
              >
                <NotepadContainer bookId={tab.bookId} />
              </div>
            </Resizable>
          );

          const chatSidebar = isChatVisible && (
            <Resizable
              defaultSize={{
                width: 370,
                height: "100%",
              }}
              minWidth={320}
              maxWidth={580}
              enable={{
                top: false,
                right: swapSidebars,
                bottom: false,
                left: !swapSidebars,
                topRight: false,
                bottomRight: false,
                bottomLeft: false,
                topLeft: false,
              }}
              handleComponent={
                swapSidebars
                  ? { right: <div className="custom-resize-handle custom-resize-handle-left" /> }
                  : { left: <div className="custom-resize-handle" /> }
              }
              className="h-full"
              onResize={() => {
                if (!showOverlay) {
                  setShowOverlay(true);
                }
              }}
              onResizeStop={() => {
                setShowOverlay(false);
                window.dispatchEvent(
                  new CustomEvent("foliate-resize-update", {
                    detail: { bookId: tab.bookId, source: "resize-drag" },
                  }),
                );
              }}
            >
              <div
                className={
                  swapSidebars ? "mr-1 h-[calc(100dvh-48px)] rounded-md" : "m-1 mt-0 h-[calc(100dvh-48px)] rounded-md"
                }
              >
                <SideChat key={`chat-${tab.id}`} bookId={tab.bookId} />
              </div>
            </Resizable>
          );

          return (
            <ReaderProvider store={store} key={tab.id}>
              <div
                className="absolute inset-0 flex bg-background p-1"
                style={{
                  visibility: tab.id === activeTabId ? "visible" : "hidden",
                  zIndex: tab.id === activeTabId ? 1 : 0,
                }}
              >
                {swapSidebars ? chatSidebar : notepadSidebar}

                <div className="relative flex-1 rounded-md border shadow-around">
                  <ReaderViewer />

                  {showOverlay && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center rounded-md bg-background/80 backdrop-blur-sm dark:bg-neutral-900/60" />
                  )}
                </div>

                {swapSidebars ? notepadSidebar : chatSidebar}
              </div>
            </ReaderProvider>
          );
        })}
      </main>

      <SettingsDialog open={isSettingsDialogOpen} onOpenChange={toggleSettingsDialog} />
    </div>
  );
}
