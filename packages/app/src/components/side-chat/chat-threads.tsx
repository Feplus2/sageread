import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useThreads } from "@/hooks/use-threads";
import { exportThreadToHtml } from "@/lib/export-thread-html";
import { exportThreadToImage } from "@/lib/export-thread-image";
import { exportThreadToMarkdown } from "@/lib/export-thread-markdown";
import { getThreadById } from "@/services/thread-service";
import type { ThreadSummary } from "@/types/thread";
import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { useCallback, useState } from "react";
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
  } = useThreads({ bookId });

  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

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

  const handleMenuClick = useCallback(
    (thread: ThreadSummary) => async (menuEvent: React.MouseEvent) => {
      menuEvent.preventDefault();
      menuEvent.stopPropagation();

      try {
        const menu = await Menu.new({
          items: [
            {
              id: "rename",
              text: "重命名",
              action: () => {
                handleOpenRename(thread);
              },
            },
            {
              id: "ai-rename",
              text: "AI 重命名",
              action: () => {
                handleAiRename(thread);
              },
            },
            {
              id: "export-markdown",
              text: "导出为 Markdown",
              action: () => {
                handleExportThread(thread);
              },
            },
            {
              id: "export-html",
              text: "导出为 HTML",
              action: () => {
                handleExportHtml(thread);
              },
            },
            {
              id: "export-image",
              text: "导出为图片",
              action: () => {
                handleExportImage(thread);
              },
            },
            {
              id: "delete",
              text: "删除",
              action: () => {
                handleNativeDelete(thread);
              },
            },
          ],
        });

        await menu.popup(new LogicalPosition(menuEvent.clientX, menuEvent.clientY));
      } catch (error) {
        console.error("显示菜单失败:", error);
      }
    },
    [handleNativeDelete, handleOpenRename, handleExportThread, handleExportHtml, handleExportImage, handleAiRename],
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
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => onSelectThread(thread)}
                onContextMenu={handleMenuClick(thread)}
                className="w-full cursor-pointer rounded-lg border p-2 text-left"
              >
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="line-clamp-1 flex-1 font-medium text-neutral-900 text-sm dark:text-neutral-100">
                    {thread.title || "未命名对话"}
                  </h3>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-600 text-xs dark:text-neutral-400">{thread.message_count} 条消息</span>
                  <span className="flex-shrink-0 text-neutral-500 text-xs dark:text-neutral-500">
                    {dayjs(thread.updated_at).format("YYYY-MM-DD HH:mm:ss")}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

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
