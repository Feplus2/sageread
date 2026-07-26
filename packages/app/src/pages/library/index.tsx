import SettingsDialog from "@/components/settings/settings-dialog";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { useBookUpload } from "@/hooks/use-book-upload";
import { useSafeAreaInsets } from "@/hooks/use-safe-areaInsets";
import { useTheme } from "@/hooks/use-theme";
import { useUICSS } from "@/hooks/use-ui-css";
import { updateBook } from "@/services/book-service";
import { type BookTagSuggestions, generateTagsForBooks } from "@/services/ai-tag-service";
import { createTag, getTags } from "@/services/tag-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLibraryStore } from "@/store/library-store";
import clsx from "clsx";
import { ListChecks, Plus, Sparkles, Tags, Trash2, Upload as UploadIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import BatchAITagDialog, { type BatchAITagSelection } from "./components/batch-ai-tag-dialog";
import BatchTagDialog from "./components/batch-tag-dialog";
import BookItem from "./components/book-item";
import CreateTagDialog from "./components/create-tag-dialog";
import EditTagDialog from "./components/edit-tag-dialog";
import Upload from "./components/upload";
import { useBooksFilter } from "./hooks/use-books-filter";
import { useBooksOperations } from "./hooks/use-books-operations";
import { useLibraryUI } from "./hooks/use-library-ui";
import { useTagsManagement } from "./hooks/use-tags-management";
import { useTagsOperations } from "./hooks/use-tags-operations";

export default function NewLibraryPage() {
  const { searchQuery, booksWithStatus, isLoading, refreshBooks } = useLibraryStore();
  const { isSettingsDialogOpen, toggleSettingsDialog } = useAppSettingsStore();
  const insets = useSafeAreaInsets();
  const { isDragOver, isUploading, handleDragOver, handleDragLeave, handleDrop, triggerFileSelect } = useBookUpload();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isInitiating = useRef(false);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [selectedTagsForDelete, setSelectedTagsForDelete] = useState<string[]>([]);

  // 书籍多选模式
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<string>>(new Set());
  const [batchTagMode, setBatchTagMode] = useState<"add" | "remove" | null>(null);
  const [isBatchOperating, setIsBatchOperating] = useState(false);

  // AI 智能批量分类
  const [aiResults, setAiResults] = useState<BookTagSuggestions[]>([]);
  const [showAIDialog, setShowAIDialog] = useState(false);
  const [isAIClassifying, setIsAIClassifying] = useState(false);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedBookIds(new Set());
  }, []);

  const toggleBookSelect = useCallback((bookId: string) => {
    setSelectedBookIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  }, []);

  // 批量应用标签（add=并集，remove=差集）
  const handleBatchApplyTags = useCallback(
    async (tagIds: string[]) => {
      if (batchTagMode == null) return;
      const selectedBooks = booksWithStatus.filter((b) => selectedBookIds.has(b.id));
      setIsBatchOperating(true);
      try {
        for (const book of selectedBooks) {
          const currentTags = book.tags || [];
          const newTags =
            batchTagMode === "add"
              ? Array.from(new Set([...currentTags, ...tagIds]))
              : currentTags.filter((t) => !tagIds.includes(t));
          await updateBook(book.id, { tags: newTags });
        }
        await refreshBooks();
        toast.success(`已为 ${selectedBooks.length} 本书籍${batchTagMode === "add" ? "添加" : "移除"}标签`);
        exitSelectionMode();
      } catch (error) {
        console.error("批量标签失败:", error);
        toast.error("批量标签失败");
      } finally {
        setIsBatchOperating(false);
      }
    },
    [batchTagMode, booksWithStatus, selectedBookIds, refreshBooks, exitSelectionMode],
  );

  // AI 智能批量分类：对选中书籍生成标签建议
  const handleAIClassify = useCallback(async () => {
    const selectedBooks = booksWithStatus.filter((b) => selectedBookIds.has(b.id));
    if (selectedBooks.length === 0) return;

    setIsAIClassifying(true);
    try {
      const existingTags = await getTags();
      const results = await generateTagsForBooks(selectedBooks, existingTags);
      setAiResults(results);
      setShowAIDialog(true);
    } catch (error) {
      console.error("AI 分类失败:", error);
      toast.error(error instanceof Error ? error.message : "AI 分类失败");
    } finally {
      setIsAIClassifying(false);
    }
  }, [booksWithStatus, selectedBookIds]);

  // 应用 AI 分类结果（现有标签直接关联，新标签先创建再关联）
  const handleApplyAITags = useCallback(
    async (selections: BatchAITagSelection[]) => {
      setIsBatchOperating(true);
      try {
        for (const sel of selections) {
          const tagIds: string[] = [];
          for (const tag of sel.tags) {
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
          const currentTags = sel.book.tags || [];
          const newTags = Array.from(new Set([...currentTags, ...tagIds]));
          await updateBook(sel.book.id, { tags: newTags });
        }
        await refreshBooks();
        toast.success(`已为 ${selections.length} 本书籍应用 AI 标签`);
        exitSelectionMode();
      } catch (error) {
        console.error("应用 AI 标签失败:", error);
        toast.error("应用 AI 标签失败");
      } finally {
        setIsBatchOperating(false);
      }
    },
    [refreshBooks, exitSelectionMode],
  );

  // 从URL获取选中的标签
  const selectedTagFromUrl = searchParams.get("tag") || "all";
  const { tags, filteredBooksByTag } = useTagsManagement(booksWithStatus, selectedTagFromUrl);
  const { filteredBooks } = useBooksFilter(filteredBooksByTag, searchQuery);
  const { viewMode, showNewTagDialog, handleCloseNewTagDialog } = useLibraryUI();
  const { handleBookDelete, handleBookUpdate } = useBooksOperations(refreshBooks);

  useTheme({ systemUIVisible: true, appThemeColor: "base-200" });
  useUICSS();

  useEffect(() => {
    if (isInitiating.current) return;
    isInitiating.current = true;

    const initLibrary = async () => {
      try {
        await refreshBooks();
        setLibraryLoaded(true);
      } catch (error) {
        console.error("Error initializing library:", error);
        setLibraryLoaded(true);
      }
    };

    initLibrary();
    return () => {
      isInitiating.current = false;
    };
  }, [refreshBooks]);

  const clearSelectedTags = useCallback(() => {
    setSelectedTagsForDelete([]);
  }, []);

  const { handleEditTagCancel, editingTag } = useTagsOperations({
    booksWithStatus,
    handleBookUpdate,
    refreshBooks,
    selectedTag: selectedTagFromUrl,
    handleTagSelect: (tagId: string) => {
      if (tagId === "all") {
        navigate("/");
      } else {
        navigate(`/?tag=${tagId}`);
      }
    },
    selectedTagsForDelete,
    tags,
    clearSelectedTags,
  });

  const visibleBooks = filteredBooks;
  const hasBooks = libraryLoaded && visibleBooks.length > 0;
  const hasLibraryBooks = libraryLoaded && booksWithStatus.length > 0;

  if (!insets || !libraryLoaded) {
    return null;
  }

  return (
    <div
      className={clsx(
        "flex h-dvh w-full bg-transparent transition-all duration-200",
        isDragOver && "bg-neutral-50 dark:bg-neutral-900/20",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-50/80 backdrop-blur-sm dark:bg-neutral-900/40">
          <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-neutral-400 border-dashed bg-white/90 px-30 py-16 shadow-lg dark:border-neutral-500 dark:bg-neutral-800/90">
            <UploadIcon className="h-12 w-12 text-neutral-600 dark:text-neutral-400" />
            <div className="text-center">
              <h3 className="font-semibold text-lg text-neutral-900 dark:text-neutral-100">拖放文件以上传</h3>
              <p className="text-neutral-600 text-sm dark:text-neutral-400">松开以上传您的书籍</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-[calc(100vh-60px)] flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-3 pt-3">
          <h3 className="font-bold text-3xl dark:border-neutral-700">
            {selectedTagFromUrl === "all"
              ? "我的图书"
              : tags.find((t) => t.id === selectedTagFromUrl)?.name || "我的图书"}
          </h3>
          <div className="flex items-center gap-2">
            {hasBooks && (
              <Button
                variant={selectionMode ? "default" : "outline"}
                size="sm"
                onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
              >
                {selectionMode ? (
                  <>
                    <X size={16} />
                    退出多选
                  </>
                ) : (
                  <>
                    <ListChecks size={16} />
                    多选
                  </>
                )}
              </Button>
            )}
            <Button onClick={triggerFileSelect} disabled={isUploading} variant="soft" size="sm">
              {isUploading ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border border-white/30 border-t-white" />
                  上传中...
                </>
              ) : (
                <>
                  <Plus size={16} />
                  添加书籍
                </>
              )}
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <Spinner loading />
          </div>
        )}

        {hasBooks ? (
          <div data-region="bookshelf" className="flex-1 overflow-y-auto p-3 pb-8">
            <div className="mx-auto">
              {searchQuery.trim() && (
                <div className="mb-4 text-base-content/70 text-sm">
                  找到 {visibleBooks.length} 本书籍，搜索词：'{searchQuery}'
                </div>
              )}

              {viewMode === "grid" ? (
                <div className="grid 3xl:grid-cols-8 grid-cols-3 gap-4 sm:grid-cols-5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                  {visibleBooks.map((book) => (
                    <BookItem
                      key={book.id}
                      book={book}
                      viewMode={viewMode}
                      availableTags={tags}
                      onDelete={handleBookDelete}
                      onUpdate={handleBookUpdate}
                      onRefresh={refreshBooks}
                      selectionMode={selectionMode}
                      isSelected={selectedBookIds.has(book.id)}
                      onToggleSelect={toggleBookSelect}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {visibleBooks.map((book) => (
                    <BookItem
                      key={book.id}
                      book={book}
                      viewMode={viewMode}
                      availableTags={tags}
                      onDelete={handleBookDelete}
                      onUpdate={handleBookUpdate}
                      onRefresh={refreshBooks}
                      selectionMode={selectionMode}
                      isSelected={selectedBookIds.has(book.id)}
                      onToggleSelect={toggleBookSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : hasLibraryBooks && searchQuery.trim() ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 px-2 text-center">
            <div className="text-base-content/50 text-lg">没有找到 '{searchQuery}' 相关的书籍</div>
            <div className="mt-2 text-base-content/40 text-sm">尝试使用不同的关键词搜索</div>
          </div>
        ) : (
          <div className="flex-1 px-2">
            <Upload />
          </div>
        )}

        {selectionMode && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 dark:border-neutral-700">
            <span className="text-neutral-600 text-sm dark:text-neutral-400">已选 {selectedBookIds.size} 本</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setSelectedBookIds(
                    selectedBookIds.size === visibleBooks.length
                      ? new Set()
                      : new Set(visibleBooks.map((b) => b.id)),
                  )
                }
              >
                {selectedBookIds.size === visibleBooks.length ? "取消全选" : "全选"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedBookIds.size === 0 || isBatchOperating}
                onClick={() => setBatchTagMode("add")}
              >
                <Tags size={16} />
                添加标签
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedBookIds.size === 0 || isBatchOperating}
                onClick={() => setBatchTagMode("remove")}
              >
                <Trash2 size={16} />
                移除标签
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedBookIds.size === 0 || isBatchOperating || isAIClassifying}
                onClick={handleAIClassify}
              >
                {isAIClassifying ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border border-current/30 border-t-current" />
                    分类中...
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    AI 分类
                  </>
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={exitSelectionMode} disabled={isBatchOperating}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>

      <BatchTagDialog
        isOpen={batchTagMode != null}
        onClose={() => setBatchTagMode(null)}
        mode={batchTagMode ?? "add"}
        bookCount={selectedBookIds.size}
        onApply={handleBatchApplyTags}
      />

      <BatchAITagDialog
        isOpen={showAIDialog}
        onClose={() => setShowAIDialog(false)}
        results={aiResults}
        onApply={handleApplyAITags}
      />

      <CreateTagDialog
        isOpen={showNewTagDialog}
        onClose={handleCloseNewTagDialog}
        books={booksWithStatus}
        selectedTag={selectedTagFromUrl}
        filteredBooksByTag={filteredBooksByTag}
        onBookUpdate={handleBookUpdate}
        onRefreshBooks={refreshBooks}
      />

      <EditTagDialog
        isOpen={!!editingTag}
        onClose={handleEditTagCancel}
        tag={editingTag}
        books={booksWithStatus}
        onBookUpdate={handleBookUpdate}
        onRefreshBooks={refreshBooks}
      />

      <SettingsDialog open={isSettingsDialogOpen} onOpenChange={toggleSettingsDialog} />
    </div>
  );
}
