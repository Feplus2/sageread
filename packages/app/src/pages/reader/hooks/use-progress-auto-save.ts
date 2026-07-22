import { getBookStatus, updateBookStatus } from "@/services/book-service";
import { throttle } from "@/utils/throttle";
import { useCallback, useEffect, useRef } from "react";
import { useReaderStore } from "../components/reader-provider";
import { isProgrammaticNavigation, markUserNavigation } from "./navigation-tracker";

// 活跃判定与 reading session 同规则：20s 无活动 / 失焦 / 窗口隐藏即暂停
const INACTIVITY_PAUSE_MS = 20 * 1000;
const APP_ACTIVITY_EVENTS = ["mousedown", "mousemove", "click", "keydown", "keyup", "wheel"] as const;

export const useProgressAutoSave = (bookId: string) => {
  const progress = useReaderStore((state) => state.progress);
  const location = useReaderStore((state) => state.location);

  // 逗留统计：当前位置的累计活跃阅读秒数
  const dwellSecondsRef = useRef(0);
  const lastLocationRef = useRef<string | null>(null);
  const prevNavigationLocationRef = useRef<string | null>(null);
  const activeRef = useRef(true);

  // 位置变化 = 用户翻页活动（供同步落地的防跳动保护判定）
  // 开书首次定位与程序化跳转（同步 goTo）不算用户翻页，否则会污染防跳动保护
  useEffect(() => {
    if (location && location !== prevNavigationLocationRef.current) {
      const isFirstLocation = prevNavigationLocationRef.current === null;
      prevNavigationLocationRef.current = location;
      if (!isFirstLocation && !isProgrammaticNavigation(bookId)) {
        markUserNavigation(bookId);
      }
    }
  }, [location, bookId]);

  // 活跃状态跟踪：活动事件/聚焦置活跃，20s 无活动/失焦/隐藏置暂停
  useEffect(() => {
    let pauseTimer: NodeJS.Timeout | null = null;

    const markActive = () => {
      activeRef.current = true;
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        activeRef.current = false;
      }, INACTIVITY_PAUSE_MS);
    };
    const markInactive = () => {
      activeRef.current = false;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        markInactive();
      } else {
        markActive();
      }
    };

    window.addEventListener("focus", markActive);
    window.addEventListener("blur", markInactive);
    document.addEventListener("visibilitychange", onVisibilityChange);
    APP_ACTIVITY_EVENTS.forEach((eventType) => {
      document.addEventListener(eventType, markActive, { passive: true });
    });
    markActive();

    return () => {
      window.removeEventListener("focus", markActive);
      window.removeEventListener("blur", markInactive);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      APP_ACTIVITY_EVENTS.forEach((eventType) => {
        document.removeEventListener(eventType, markActive);
      });
      if (pauseTimer) clearTimeout(pauseTimer);
    };
  }, []);

  // 每秒累计活跃阅读秒数（暂停时不计）
  useEffect(() => {
    const timer = setInterval(() => {
      if (activeRef.current) {
        dwellSecondsRef.current += 1;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const updateBookProgressWithStatus = useCallback(async () => {
    const currentProgress = progress;
    if (!currentProgress || !currentProgress.pageinfo || !location) {
      return;
    }

    try {
      const progressCurrent = currentProgress.pageinfo.current;
      const progressTotal = currentProgress.pageinfo.total;
      const now = Date.now();
      const currentStatus = await getBookStatus(bookId);

      let newStatus: "unread" | "reading" | "completed" = "reading";
      if (progressCurrent >= progressTotal) {
        newStatus = "completed";
      } else if (progressCurrent > 0) {
        newStatus = "reading";
      }

      // dwell 随进度上报：翻页后的首次保存带的是"上一位置的累计逗留"，
      // Rust 侧据此判定真翻页（>= 阈值）后我们再清零重新累计
      const dwellToSend = Math.floor(dwellSecondsRef.current);

      const updateData: Parameters<typeof updateBookStatus>[1] = {
        status: newStatus,
        progressCurrent,
        progressTotal,
        location,
        lastReadAt: now,
        dwellSeconds: dwellToSend,
      };

      if (!currentStatus?.startedAt && progressCurrent > 0) {
        updateData.startedAt = now;
      }

      if (newStatus === "completed" && !currentStatus?.completedAt) {
        updateData.completedAt = now;
      }

      await updateBookStatus(bookId, updateData);

      // 位置已入库：翻页则清零逗留重新累计
      if (location !== lastLocationRef.current) {
        lastLocationRef.current = location;
        dwellSecondsRef.current = 0;
      }
    } catch (error) {
      console.error("Failed to update book progress:", error);
    }
  }, [bookId, progress, location]);

  const performSave = useCallback(async () => {
    await updateBookProgressWithStatus();
  }, [updateBookProgressWithStatus]);

  const immediateSaveConfig = performSave;

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const saveProgress = useCallback(throttle(performSave, 5000), [performSave]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    saveProgress();
    return () => {
      immediateSaveConfig().catch((error) => {
        console.error(`Failed to save progress on cleanup for book ${bookId}:`, error);
      });
    };
  }, [progress, bookId, saveProgress, immediateSaveConfig]);
};
