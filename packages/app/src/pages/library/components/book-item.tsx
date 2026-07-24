import AITagConfirmDialog from "@/components/ai/tag-confirm-dialog";
import { useDownloadImage } from "@/hooks/use-download-image";
import { useModelSelector } from "@/hooks/use-model-selector";
import type { BookTag } from "@/pages/library/hooks/use-tags-management";
import { type AITagSuggestion, generateTagsWithAI } from "@/services/ai-tag-service";
import { updateBookVectorizationMeta } from "@/services/book-service";
import { type EpubIndexResult, indexEpub } from "@/services/book-service";
import { syncDownloadBook } from "@/services/sync-service";
import { createTag, getTags } from "@/services/tag-service";
import { useLayoutStore } from "@/store/layout-store";
import { useNotificationStore } from "@/store/notification-store";
import type { BookWithStatusAndUrls } from "@/types/simple-book";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { appDataDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { Cloud, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import EditInfo from "./edit-info";
import EmbeddingDialog from "./embedding-dialog";

interface BookUpdateData {
  title?: string;
  author?: string;
  coverPath?: string;
  tags?: string[];
}

interface BookItemProps {
  book: BookWithStatusAndUrls;
  viewMode?: "grid" | "list";
  availableTags?: BookTag[];
  onDelete?: (book: BookWithStatusAndUrls) => Promise<boolean>;
  onUpdate?: (bookId: string, updates: BookUpdateData) => Promise<boolean>;
  onRefresh?: () => Promise<void>;
}

export default function BookItem({ book, availableTags = [], onDelete, onUpdate, onRefresh }: BookItemProps) {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const { downloadImage } = useDownloadImage();

  // AI标签生成相关状态
  const [showAITagDialog, setShowAITagDialog] = useState(false);
  const [aiTagSuggestions, setAiTagSuggestions] = useState<AITagSuggestion[]>([]);
  const [isAITagLoading, setIsAITagLoading] = useState(false);
  const { selectedModel } = useModelSelector();
  const [showEmbeddingDialog, setShowEmbeddingDialog] = useState(false);
  const [vectorizeProgress, setVectorizeProgress] = useState<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      const off = await listen<{
        book_id: string;
        current: number;
        total: number;
        percent: number;
        chapter_title: string;
        chunk_index: number;
      }>("epub://index-progress", (e) => {
        const p = e.payload;
        if (p && p.book_id === book.id) {
          setVectorizeProgress(Math.max(0, Math.min(100, Math.round(p.percent))));
        }
      });
      unlisten = off;
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [book.id]);

  const { openBook } = useLayoutStore();
  const [isCloudOnly, setIsCloudOnly] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // 检测书籍文件是否仅在云端（本地文件不存在）
  useEffect(() => {
    if (book.filePath) {
      appDataDir().then((base) => exists(`${base}/${book.filePath}`)).then((fileExists) => {
        setIsCloudOnly(!fileExists);
      }).catch(() => setIsCloudOnly(false));
    }
  }, [book.filePath]);

  const handleClick = useCallback(async () => {
    if (isCloudOnly) {
      setIsDownloading(true);
      try {
        toast.info(`正在下载《${book.title}》...`);
        await syncDownloadBook(book.id);
        setIsCloudOnly(false);
        openBook(book.id, book.title);
      } catch (error) {
        console.error("下载书籍失败:", error);
        toast.error("下载失败", { description: String(error) });
      } finally {
        setIsDownloading(false);
      }
    } else {
      openBook(book.id, book.title);
    }
  }, [book.id, book.title, isCloudOnly, openBook]);

  const handleAIGenerateTags = useCallback(async () => {
    if (!selectedModel) {
      toast.error("请先在设置中配置AI模型");
      return;
    }

    setIsAITagLoading(true);

    // 显示正在请求的toast
    toast.info("正在请求AI生成标签...");

    try {
      // 获取现有标签
      const existingTags = await getTags();

      // 调用AI生成标签
      const aiResponse = await generateTagsWithAI(book, existingTags, {
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
      });

      setAiTagSuggestions(aiResponse.suggestions);
      setShowAITagDialog(true);
    } catch (error) {
      console.error("AI生成标签失败:", error);
      toast.error(error instanceof Error ? error.message : "AI生成标签失败，请重试");
    } finally {
      setIsAITagLoading(false);
    }
  }, [selectedModel, book]);

  const handleAITagConfirm = useCallback(
    async (selectedTags: { name: string; isExisting: boolean; existingTagId?: string }[]) => {
      if (selectedTags.length === 0) {
        setShowAITagDialog(false);
        return;
      }

      setIsAITagLoading(true);

      try {
        const tagIds: string[] = [];

        for (const tag of selectedTags) {
          if (tag.isExisting && tag.existingTagId) {
            tagIds.push(tag.existingTagId);
          } else {
            const newTag = await createTag({
              name: tag.name,
              color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
            });
            tagIds.push(newTag.id);
          }
        }

        const currentTags = book.tags || [];
        const updatedTags = Array.from(new Set([...currentTags, ...tagIds]));

        if (onUpdate) {
          const success = await onUpdate(book.id, { tags: updatedTags });

          if (success) {
            toast.success(`成功添加 ${selectedTags.length} 个标签`);

            if (onRefresh) {
              await onRefresh();
            }
          } else {
            toast.error("添加标签失败，请重试");
          }
        }

        setShowAITagDialog(false);
      } catch (error) {
        console.error("添加AI标签失败:", error);
        toast.error(error instanceof Error ? error.message : "添加标签失败，请重试");
      } finally {
        setIsAITagLoading(false);
      }
    },
    [book, onUpdate, onRefresh],
  );

  const handleNativeDelete = useCallback(async () => {
    if (onDelete) {
      try {
        const confirmed = await ask(`确定要删除《${book.title}》吗？\n\n书籍将被移入回收站，可在回收站中恢复。`, {
          title: "确认删除",
          kind: "warning",
        });

        if (confirmed) {
          await onDelete(book);
        }
      } catch (error) {
        console.error("Failed to show delete dialog:", error);
      }
    }
  }, [onDelete, book]);

  const handleDownloadImage = useCallback(async () => {
    if (!book.coverUrl) {
      console.warn("No cover image available for download");
      return;
    }

    await downloadImage(book.coverUrl, {
      title: book.title,
      defaultFileName: `${book.title}_cover`,
    });
  }, [book.coverUrl, book.title, downloadImage]);

  // Extracted vectorization action
  const handleVectorizeBook = useCallback(async () => {
    const { addNotification } = useNotificationStore.getState();

    const vectorConfig = await getCurrentVectorModelConfig();
    const version = 1;

    try {
      toast.info("开始向量化...");
      setVectorizeProgress(0);
      await updateBookVectorizationMeta(book.id, {
        status: "processing",
        model: vectorConfig.model,
        dimension: vectorConfig.dimension,
        version,
        startedAt: Date.now(),
      });

      const res: EpubIndexResult = await indexEpub(book.id, {
        dimension: vectorConfig.dimension,
        embeddingsUrl: vectorConfig.embeddingsUrl,
        model: vectorConfig.model,
        apiKey: vectorConfig.apiKey,
      });

      if (res?.success && res.report) {
        await updateBookVectorizationMeta(book.id, {
          status: "success",
          chunkCount: res.report.total_chunks,
          dimension: res.report.vector_dimension,
          finishedAt: Date.now(),
        });
      } else {
        await updateBookVectorizationMeta(book.id, {
          status: "failed",
          finishedAt: Date.now(),
        });
        throw new Error(res?.message || "向量化失败");
      }
      const message = `《${book.title}》向量化完成，分块数：${res.report?.total_chunks ?? "未知"}`;
      toast.success(message);
      addNotification(message);
      setVectorizeProgress(null);
      if (onRefresh) await onRefresh();
    } catch (err) {
      console.error("向量化失败", err);
      await updateBookVectorizationMeta(book.id, {
        status: "failed",
        finishedAt: Date.now(),
      });
      setVectorizeProgress(null);
      const errorMessage = `《${book.title}》向量化失败`;
      toast.error("向量化失败，请检查嵌入服务是否可用");
      addNotification(errorMessage);
      if (onRefresh) await onRefresh();
    }
  }, [book.id, book.title, onRefresh]);

  const handleTagToggle = useCallback(
    async (tagId: string) => {
      if (!onUpdate) return;

      const currentTags = book.tags || [];
      const hasTag = currentTags.includes(tagId);

      let newTags: string[];
      if (hasTag) {
        // 移除标签
        newTags = currentTags.filter((tag) => tag !== tagId);
      } else {
        // 添加标签（去重）
        newTags = Array.from(new Set([...currentTags, tagId]));
      }

      try {
        await onUpdate(book.id, { tags: newTags });
      } catch (error) {
        console.error("Failed to update tags:", error);
      }
    },
    [book.id, book.tags, onUpdate],
  );

  const renderProgress = () => {
    if (!book.status) {
      return null;
    }

    const { status, progressCurrent = 0, progressTotal = 0 } = book.status;

    if (status === "unread") {
      return (
        <div className="inline-block rounded-full bg-neutral-100 px-1.5 py-0.5 text-neutral-600 text-xs dark:bg-neutral-800 dark:text-neutral-300">
          New
        </div>
      );
    }

    if (status === "completed") {
      return (
        <div className="inline-block rounded-full bg-green-100 px-2 py-1 font-medium text-green-600 text-xs dark:bg-green-900 dark:text-green-300">
          Complete
        </div>
      );
    }

    const progress = progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0;
    return (
      <div className="flex items-center gap-1">
        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
        <span className="text-neutral-500 text-xs dark:text-neutral-400">{progress}%</span>
      </div>
    );
  };

  const renderVectorizationStatus = () => {
    const statusFromMeta = book.status?.metadata?.vectorization?.status ?? "idle";
    const effectiveStatus =
      vectorizeProgress != null && vectorizeProgress >= 0 && vectorizeProgress < 100 ? "processing" : statusFromMeta;

    if (effectiveStatus === "processing") {
      const pct = Math.max(0, Math.min(100, vectorizeProgress ?? 0));
      return (
        <div className="flex items-center gap-1" title={`向量化: processing ${pct}%`}>
          <div className="relative h-4 w-4" aria-label={`processing ${pct}%`}>
            <div
              className="absolute inset-0 rounded-full"
              style={{ background: `conic-gradient(#eab308 ${pct}%, rgba(229,231,235,0.6) 0)` }}
            />
            <div className="absolute inset-[2px] rounded-full bg-white dark:bg-neutral-900" />
          </div>
          <span className="text-[10px] text-neutral-500 leading-none dark:text-neutral-400">{pct}%</span>
        </div>
      );
    }

    const colorClass =
      effectiveStatus === "success"
        ? "border-green-500"
        : effectiveStatus === "failed"
          ? "border-red-500"
          : "border-neutral-400 dark:border-neutral-500";
    return (
      <div className="flex items-center gap-1" title={`向量化: ${effectiveStatus}`}>
        <div className={`h-3.5 w-3.5 rounded-full border-2 ${colorClass}`} />
      </div>
    );
  };

  const handleMenuClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        const separator1 = await PredefinedMenuItem.new({ text: "separator-1", item: "Separator" });
        const separator2 = await PredefinedMenuItem.new({ text: "separator-2", item: "Separator" });
        const separator3 = await PredefinedMenuItem.new({ text: "separator-3", item: "Separator" });

        const isUnread = !book.status || book.status.status === "unread";
        const markStatusItem = {
          id: isUnread ? "mark-read" : "mark-unread",
          text: isUnread ? "标记为已读" : "标记为未读",
          action: () => {
            if (isUnread) {
              console.log("Mark as Read clicked");
            } else {
              console.log("Mark as Unread clicked");
            }
          },
        };

        const currentTags = book.tags || [];

        const allTagMenuItems: any[] = [];

        const aiGenerateItem = await MenuItem.new({
          id: "ai-generate-tags",
          text: "AI 生成",
          action: () => {
            handleAIGenerateTags();
          },
        });
        allTagMenuItems.push(aiGenerateItem);

        if (availableTags.length > 0) {
          const aiSeparator = await PredefinedMenuItem.new({ text: "ai-separator", item: "Separator" });
          allTagMenuItems.push(aiSeparator);
          const databaseTags = await getTags();
          const tagMenuItems = await Promise.all(
            availableTags
              .filter((tag) => tag.id !== "all" && tag.id !== "uncategorized")
              .map(async (tag) => {
                const tagName = tag.id.startsWith("tag-") ? tag.id.replace("tag-", "") : tag.name;
                const dbTag = databaseTags.find((t) => t.name === tagName);
                const realTagId = dbTag?.id;
                const hasTag = realTagId ? currentTags.includes(realTagId) : false;

                return await MenuItem.new({
                  id: `tag-${tag.id}`,
                  text: `${hasTag ? "✓ " : ""}${tagName}`,
                  action: () => {
                    if (realTagId) {
                      handleTagToggle(realTagId);
                    }
                  },
                });
              }),
          );

          allTagMenuItems.push(...tagMenuItems);
        }

        const tagsSubmenu = await Submenu.new({
          text: "管理标签",
          items: allTagMenuItems,
        });

        const vectorMeta = book.status?.metadata?.vectorization;
        const isVectorized = vectorMeta?.status === "success";

        const vectorizeSubmenuItems = [];

        if (isVectorized) {
          vectorizeSubmenuItems.push(
            await MenuItem.new({
              id: "vector-info",
              text: "✓ 已向量化",
              enabled: false,
            }),
            await MenuItem.new({
              id: "vector-model",
              text: `模型: ${vectorMeta?.model || "未知"}`,
              enabled: false,
            }),
            await MenuItem.new({
              id: "vector-dimension",
              text: `维度: ${vectorMeta?.dimension || 0}`,
              enabled: false,
            }),
            await MenuItem.new({
              id: "vector-chunks",
              text: `分块: ${vectorMeta?.chunkCount || 0}`,
              enabled: false,
            }),
          );
        }

        vectorizeSubmenuItems.push(
          await MenuItem.new({
            id: "vectorize-epub",
            text: isVectorized ? "重新向量化" : "开始向量化",
            action: async () => {
              await handleVectorizeBook();
            },
          }),
          await MenuItem.new({
            id: "test-vector",
            text: "向量化测试",
            action: () => {
              setShowEmbeddingDialog(true);
            },
          }),
        );

        const vectorizeSubmenu = await Submenu.new({
          text: `${isVectorized ? "✓ " : ""}向量化`,
          items: vectorizeSubmenuItems,
        });

        const menu = await Menu.new({
          items: [
            {
              id: "open",
              text: "打开",
              action: () => {
                handleClick();
              },
            },
            vectorizeSubmenu,
            separator1,
            {
              id: "edit",
              text: "编辑信息",
              action: () => {
                setShowEditDialog(true);
              },
            },
            ...(book.coverUrl
              ? [
                  {
                    id: "download-image",
                    text: "下载图片",
                    action: () => {
                      handleDownloadImage();
                    },
                  },
                ]
              : []),
            tagsSubmenu,
            separator2,
            markStatusItem,
            separator3,
            {
              id: "delete",
              text: "删除",
              action: () => {
                handleNativeDelete();
              },
            },
          ],
        });

        await menu.popup(new LogicalPosition(e.clientX, e.clientY));
      } catch (error) {
        console.error("Failed to show native menu:", error);
      }
    },
    [
      handleClick,
      handleNativeDelete,
      handleDownloadImage,
      handleTagToggle,
      handleAIGenerateTags,
      handleVectorizeBook,
      book.coverUrl,
      book.status,
      availableTags,
      book.tags,
    ],
  );

  return (
    <>
      <div className="group cursor-pointer" onClick={handleClick}>
        <div
          onContextMenu={handleMenuClick}
          data-region="book-card"
          className="rounded-r-2xl rounded-l-md border border-neutral-200 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-700 dark:bg-neutral-800"
        >
          <div className="relative p-2 pb-0">
            <div className="mb-2">
              <h4 className="truncate text-neutral-600 text-sm leading-tight dark:text-neutral-200">{book.title}</h4>
            </div>

            <div data-region="book-cover" className="relative aspect-[4/5] w-full overflow-hidden">
              {book.coverUrl ? (
                <img src={book.coverUrl} alt={book.title} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-neutral-100 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800">
                  <div className="p-4 text-center">
                    <div className="mb-2 font-bold text-2xl text-neutral-500 dark:text-neutral-400">📖</div>
                    <div className="line-clamp-3 text-neutral-600 text-xs dark:text-neutral-300">{book.title}</div>
                  </div>
                </div>
              )}
              {isCloudOnly && (
                <div className="absolute top-1 right-1 rounded-full bg-black/60 p-1" title="仅在云端，点击打开时自动下载">
                  <Cloud size={12} className="text-white" />
                </div>
              )}
              {isDownloading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <span className="text-white text-xs">下载中...</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex h-8 items-center justify-between space-x-2 p-2 py-0">
            <div className="flex-1">{renderProgress()}</div>
            <div className="flex items-center gap-2">
              {renderVectorizationStatus()}
              <MoreHorizontal onClick={handleMenuClick} className="h-4 w-4 text-neutral-500 dark:text-neutral-400" />
            </div>
          </div>
        </div>
      </div>

      <EditInfo book={book} isOpen={showEditDialog} onClose={() => setShowEditDialog(false)} onSave={onUpdate} />

      <AITagConfirmDialog
        isOpen={showAITagDialog}
        onClose={() => setShowAITagDialog(false)}
        suggestions={aiTagSuggestions}
        bookTitle={book.title}
        bookAuthor={book.author}
        onConfirm={handleAITagConfirm}
        isLoading={isAITagLoading}
      />

      <EmbeddingDialog isOpen={showEmbeddingDialog} onClose={() => setShowEmbeddingDialog(false)} bookId={book.id} />
    </>
  );
}
