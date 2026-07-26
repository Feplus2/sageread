import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useThreads } from "@/hooks/use-threads";
import { exportThreadToHtml } from "@/lib/export-thread-html";
import { exportThreadToImage } from "@/lib/export-thread-image";
import { exportThreadToMarkdown } from "@/lib/export-thread-markdown";
import { getThreadById } from "@/services/thread-service";
import type { ThreadSummary } from "@/types/thread";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { ArrowLeft, Check, Download, ListChecks, MessageCircle, Star, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

interface ChatThreadsProps {
  bookId: string | undefined;
  onBack: () => void;
  onSelectThread: (threadSummary: ThreadSummary) => void;
}

export function ChatThreads({ bookId, onBack, onSelectThread }: ChatThreadsProps) {
  const {
    threads,
    error,
    status,
    handleDeleteThread: deleteThreadFn,
    handleRenameThread: renameThreadFn,
    handleAiRenameThread: aiRenameThreadFn,
    handleToggleStar: toggleStarFn,
  } = useThreads({ bookId });

  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  // 多选模式
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchOperating, setIsBatchOperating] = useState(false);

  const sortedThreads = threads;

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((threadId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  const allSelected = useMemo(
    () => threads.length > 0 && threads.every((t) => selectedIds.has(t.id)),
    [threads, selectedIds],
  );

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(threads.map((t) => t.id)));
    }
  }, [allSelected, threads]);

  const handleNativeDelete = useCallback(
    async (thread: ThreadSummary) => {
      try {
        const confirmed = await ask(`确定要删除这个对话吗？\n\n"${thread.title || "未命名对话"}"\n\n此操作无法撤销。`, {
          title: "确认删除",
          kind: "warning",
        });

        if (confirmed) {
          await deleteThreadFn(thread.id);
        }
      } catch (error) {
        console.error("删除对话失败:", error);
      }
    },
    [deleteThreadFn],
  );

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      const confirmed = await ask(`确定要删除选中的 ${selectedIds.size} 个对话吗？\n\n此操作无法撤销。`, {
        title: "确认批量删除",
        kind: "warning",
      });
      if (!confirmed) return;

      setIsBatchOperating(true);
      for (const id of selectedIds) {
        await deleteThreadFn(id);
      }
      exitSelectionMode();
    } catch (error) {
      console.error("批量删除失败:", error);
      toast.error("批量删除失败");
    } finally {
      setIsBatchOperating(false);
    }
  }, [selectedIds, deleteThreadFn, exitSelectionMode]);

  const handleBatchStar = useCallback(async () => {
    const selectedThreads = threads.filter((t) => selectedIds.has(t.id));
    if (selectedThreads.length === 0) return;

    // 全部已星标则取消，否则全部星标
    const allStarred = selectedThreads.every((t) => t.starred);
    setIsBatchOperating(true);
    try {
      for (const thread of selectedThreads) {
        const shouldStar = !allStarred;
        if (!!thread.starred !== shouldStar) {
          await toggleStarFn(thread);
        }
      }
      exitSelectionMode();
    } catch (error) {
      console.error("批量星标失败:", error);
      toast.error("批量星标失败");
    } finally {
      setIsBatchOperating(false);
    }
  }, [threads, selectedIds, toggleStarFn, exitSelectionMode]);

  const handleBatchExport = useCallback(async () => {
    const selectedThreads = threads.filter((t) => selectedIds.has(t.id));
    if (selectedThreads.length === 0) return;

    setIsBatchOperating(true);
    try {
      // 每个对话各自导出为一个 Markdown 文件
      for (const thread of selectedThreads) {
        const fullThread = await getThreadById(thread.id);
        await exportThreadToMarkdown(fullThread);
      }
      toast.success(`已导出 ${selectedThreads.length} 个对话`);
      exitSelectionMode();
    } catch (error) {
      console.error("批量导出失败:", error);
      toast.error("批量导出失败");
    } finally {
      setIsBatchOperating(false);
    }
  }, [threads, selectedIds, exitSelectionMode]);

  const handleOpenRename = useCallback((thread: ThreadSummary) => {
    setRenameTitle(thread.title || "");
    setRenameTarget(thread);
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renameTarget) return;

    const title = renameTitle.trim();
    if (!title) {
      toast.error("标题不能为空");
      return;
    }

    setIsRenaming(true);
    try {
      await renameThreadFn(renameTarget.id, title);
      setRenameTarget(null);
    } catch {
      // 失败提示已在 useThreads 中处理
    } finally {
      setIsRenaming(false);
    }
  }, [renameTarget, renameTitle, renameThreadFn]);

  const handleExportThread = useCallback(async (thread: ThreadSummary) => {
    try {
      const fullThread = await getThreadById(thread.id);
      await exportThreadToMarkdown(fullThread);
    } catch (error) {
      console.error("导出对话失败:", error);
      toast.error("导出对话失败");
    }
  }, []);

  const handleExportHtml = useCallback(async (thread: ThreadSummary) => {
    try {
      const fullThread = await getThreadById(thread.id);
      await exportThreadToHtml(fullThread);
    } catch (error) {
      console.error("导出对话失败:", error);
      toast.error("导出对话失败");
    }
  }, []);

  const handleExportImage = useCallback(async (thread: ThreadSummary) => {
    try {
      const fullThread = await getThreadById(thread.id);
      await exportThreadToImage(fullThread);
    } catch (error) {
      console.error("导出对话失败:", error);
      toast.error("导出对话失败");
    }
  }, []);

  const handleAiRename = useCallback(
    (thread: ThreadSummary) => {
      if (!thread.message_count) {
        toast.error("对话为空，无法生成标题");
        return;
      }
      aiRenameThreadFn(thread.id);
    },
    [aiRenameThreadFn],
  );

  const handleCardClick = useCallback(
    (thread: ThreadSummary) => {
      if (selectionMode) {
        toggleSelect(thread.id);
      } else {
        onSelectThread(thread);
      }
    },
    [selectionMode, toggleSelect, onSelectThread],
  );

  if (status === "pending") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 items-center gap-2 border-neutral-300 pl-0.5 dark:border-neutral-700">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
            onClick={onBack}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h2 className="font-medium text-neutral-900 dark:text-neutral-100">历史对话</h2>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="text-neutral-600 dark:text-neutral-400">加载中...</div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 items-center gap-2 border-neutral-300 pl-0.5 dark:border-neutral-700">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
            onClick={onBack}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h2 className="font-medium text-neutral-900 dark:text-neutral-100">历史对话</h2>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="mb-2 text-neutral-600 dark:text-neutral-400">{error?.message || "加载历史对话失败"}</div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
              className="border-neutral-200 dark:border-neutral-700"
            >
              重试
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-neutral-300 dark:border-neutral-700">
        <div className="flex h-10 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
            onClick={onBack}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h2 className="font-medium text-neutral-900 text-sm dark:text-neutral-100">历史对话</h2>
          <span className="text-neutral-500 text-xs dark:text-neutral-500">({threads.length})</span>
          <div className="ml-auto flex items-center gap-1 pr-1">
            {selectionMode && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={handleSelectAll}
              >
                {allSelected ? "取消全选" : "全选"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              title="多选管理"
              className={`size-7 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 ${
                selectionMode ? "bg-neutral-200 dark:bg-neutral-700" : ""
              }`}
              onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
            >
              <ListChecks className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-8">
        {threads.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-3 w-fit rounded-full bg-neutral-100 p-3 dark:bg-neutral-800">
                <MessageCircle size={24} className="text-neutral-500 dark:text-neutral-500" />
              </div>
              <p className="text-neutral-600 text-sm dark:text-neutral-400">
                {bookId ? "还没有历史对话" : "暂无聊天记录"}
              </p>
              <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-500">
                {bookId ? "开始聊天来创建你的第一个对话" : "开始对话来创建聊天记录"}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedThreads.map((thread) => (
              <ContextMenu key={thread.id}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => handleCardClick(thread)}
                    className="group w-full cursor-pointer rounded-lg border p-2 text-left"
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      {selectionMode && (
                        <span
                          className={`mt-0.5 flex size-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
                            selectedIds.has(thread.id)
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-neutral-400 dark:border-neutral-500"
                          }`}
                        >
                          {selectedIds.has(thread.id) && <Check size={12} />}
                        </span>
                      )}
                      <h3 className="line-clamp-1 flex-1 font-medium text-neutral-900 text-sm dark:text-neutral-100">
                        {thread.title || "未命名对话"}
                      </h3>
                      <span
                        role="button"
                        tabIndex={-1}
                        title={thread.starred ? "取消星标" : "星标"}
                        className={`flex-shrink-0 cursor-pointer opacity-40 transition-opacity hover:opacity-100 group-hover:opacity-70 ${
                          thread.starred ? "opacity-100" : ""
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleStarFn(thread);
                        }}
                      >
                        <Star
                          className={`size-3.5 ${thread.starred ? "fill-amber-400 text-amber-400" : "text-neutral-400"}`}
                        />
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-neutral-600 text-xs dark:text-neutral-400">
                        {thread.message_count} 条消息
                      </span>
                      <span className="flex-shrink-0 text-neutral-500 text-xs dark:text-neutral-500">
                        {dayjs(thread.updated_at).format("YYYY-MM-DD HH:mm:ss")}
                      </span>
                    </div>
                  </button>
                </ContextMenuTrigger>
                {!selectionMode && (
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => handleOpenRename(thread)}>重命名</ContextMenuItem>
                    <ContextMenuItem onClick={() => handleAiRename(thread)}>AI 重命名</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => handleExportThread(thread)}>导出为 Markdown</ContextMenuItem>
                    <ContextMenuItem onClick={() => handleExportHtml(thread)}>导出为 HTML</ContextMenuItem>
                    <ContextMenuItem onClick={() => handleExportImage(thread)}>导出为图片</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onClick={() => handleNativeDelete(thread)}>
                      删除
                    </ContextMenuItem>
                  </ContextMenuContent>
                )}
              </ContextMenu>
            ))}
          </div>
        )}
      </div>

      {selectionMode && (
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 dark:border-neutral-700">
          <span className="text-nowrap text-neutral-600 text-xs dark:text-neutral-400">已选 {selectedIds.size} 个</span>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.size === 0 || isBatchOperating}
              onClick={handleBatchExport}
            >
              <Download className="h-3.5 w-3.5" />
              导出
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.size === 0 || isBatchOperating}
              onClick={handleBatchStar}
            >
              <Star className="h-3.5 w-3.5" />
              星标
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.size === 0 || isBatchOperating}
              onClick={handleBatchDelete}
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
            <Button variant="ghost" size="sm" onClick={exitSelectionMode} disabled={isBatchOperating}>
              取消
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open && !isRenaming) {
            setRenameTarget(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 p-4">
            <Input
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              placeholder="输入新的对话标题"
              maxLength={50}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isRenaming) {
                  e.preventDefault();
                  handleConfirmRename();
                }
              }}
            />
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={isRenaming}>
                取消
              </Button>
              <Button onClick={handleConfirmRename} disabled={isRenaming || !renameTitle.trim()} className="min-w-24">
                {isRenaming ? "保存中..." : "确定"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
