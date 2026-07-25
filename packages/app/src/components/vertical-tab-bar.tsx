import { useLayoutStore } from "@/store/layout-store";
import { BookOpen, HomeIcon, PanelLeftClose, PanelLeftOpen, PanelTop, X } from "lucide-react";
import { useState } from "react";

/**
 * 垂直标签栏（仿 Edge）：
 * - 展开态 220px：Home + 切换横向 + 折叠按钮，标签列表可滚动、可拖拽排序、中键关闭
 * - 折叠态 48px：仅图标，hover 显示 title 提示
 */
export default function VerticalTabBar() {
  const {
    tabs,
    activeTabId,
    isHomeActive,
    isVerticalTabCollapsed,
    activateTab,
    removeTab,
    navigateToHome,
    reorderTab,
    toggleTabOrientation,
    toggleVerticalTabCollapsed,
  } = useLayoutStore();

  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const handleDragOver = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIndex === null || dragIndex === targetIndex) return;
    const dragTab = tabs[dragIndex];
    if (!dragTab) return;
    reorderTab(dragTab.id, dragIndex, targetIndex);
    setDragIndex(targetIndex);
  };

  // ─── 折叠态 ───
  if (isVerticalTabCollapsed) {
    return (
      <div
        data-region="vertical-tabs"
        className="flex w-12 shrink-0 select-none flex-col items-center border-neutral-200 bg-muted py-2 dark:border-neutral-700 dark:bg-tab-background"
        style={{ borderRightWidth: 1 }}
      >
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
          onClick={toggleVerticalTabCollapsed}
          title="展开标签栏"
        >
          <PanelLeftOpen className="size-4" />
        </button>

        <button
          type="button"
          className={`mt-1 flex size-8 items-center justify-center rounded-md ${
            isHomeActive
              ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
              : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
          }`}
          onClick={navigateToHome}
          title="主页"
        >
          <HomeIcon className="size-4" />
        </button>

        <div className="mt-2 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={() => setDragIndex(null)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  removeTab(tab.id);
                }
              }}
              className={`group flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors ${
                tab.id === activeTabId
                  ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
              } ${dragIndex === index ? "opacity-50" : ""}`}
              onClick={() => activateTab(tab.id)}
              title={tab.title}
            >
              <BookOpen className="size-4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── 展开态 ───
  return (
    <div
      data-region="vertical-tabs"
      className="flex w-[220px] shrink-0 select-none flex-col border-neutral-200 bg-muted dark:border-neutral-700 dark:bg-tab-background"
      style={{ borderRightWidth: 1 }}
    >
      {/* 头部：Home + 切换横向 + 折叠 */}
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <button
          type="button"
          className={`flex size-7 items-center justify-center rounded-md ${
            isHomeActive
              ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
              : "text-neutral-700 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
          }`}
          onClick={navigateToHome}
          title="主页"
        >
          <HomeIcon className="size-4" />
        </button>

        <div className="flex-1" />

        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
          onClick={toggleTabOrientation}
          title="切换到横向标签"
        >
          <PanelTop className="size-4" />
        </button>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
          onClick={toggleVerticalTabCollapsed}
          title="折叠标签栏"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>

      {/* 标签列表 */}
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              setDragIndex(index);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={() => setDragIndex(null)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                removeTab(tab.id);
              }
            }}
            className={`group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors ${
              tab.id === activeTabId
                ? "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
                : "text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
            } ${dragIndex === index ? "opacity-50" : ""}`}
            onClick={() => activateTab(tab.id)}
            title={tab.title}
          >
            <BookOpen className="size-4 shrink-0" />
            <span className="flex-1 truncate">{tab.title}</span>
            <button
              type="button"
              className={`flex size-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-neutral-300 dark:hover:bg-neutral-600 ${
                tab.id === activeTabId ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                removeTab(tab.id);
              }}
              aria-label="关闭标签"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
