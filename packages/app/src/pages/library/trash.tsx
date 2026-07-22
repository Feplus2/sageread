import { Button } from "@/components/ui/button";
import { getTrashedBooks, purgeBook, restoreBook } from "@/services/book-service";
import { useLibraryStore } from "@/store/library-store";
import type { SimpleBook } from "@/types/simple-book";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

// 与 Rust 侧 TRASH_RETENTION_DAYS 保持一致
const RETENTION_DAYS = 30;

type TrashedBook = SimpleBook & { coverUrl?: string };

export default function TrashPage() {
  const { refreshBooks } = useLibraryStore();
  const [trashedBooks, setTrashedBooks] = useState<TrashedBook[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadTrashedBooks = useCallback(async () => {
    setIsLoading(true);
    try {
      const books = await getTrashedBooks();
      const appDataDirPath = await appDataDir();
      setTrashedBooks(
        books.map((book) => ({
          ...book,
          coverUrl: book.coverPath ? convertFileSrc(`${appDataDirPath}/${book.coverPath}`) : undefined,
        })),
      );
    } catch (error) {
      console.error("加载回收站失败:", error);
      toast.error("加载回收站失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTrashedBooks();
  }, [loadTrashedBooks]);

  const remainingDays = (trashedAt?: number | null): number => {
    if (!trashedAt) return RETENTION_DAYS;
    const elapsedDays = Math.floor((Date.now() - trashedAt) / (24 * 60 * 60 * 1000));
    return Math.max(0, RETENTION_DAYS - elapsedDays);
  };

  const handleRestore = async (book: TrashedBook) => {
    try {
      await restoreBook(book.id);
      toast.success(`已恢复《${book.title}》`);
      await loadTrashedBooks();
      await refreshBooks();
    } catch (error) {
      console.error("恢复书籍失败:", error);
      toast.error("恢复书籍失败");
    }
  };

  const handlePurge = async (book: TrashedBook) => {
    try {
      const confirmed = await ask(
        `确定要彻底删除《${book.title}》吗？\n\n书籍文件和全部数据（阅读进度、笔记、对话）将被永久移除，此操作无法撤销。`,
        { title: "彻底删除", kind: "warning" },
      );
      if (!confirmed) return;

      await purgeBook(book.id);
      toast.success("已彻底删除");
      await loadTrashedBooks();
    } catch (error) {
      console.error("彻底删除书籍失败:", error);
      toast.error("彻底删除书籍失败");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 pt-3">
        <h3 className="font-bold text-3xl dark:border-neutral-700">回收站</h3>
        <span className="text-neutral-500 text-xs dark:text-neutral-500">
          删除的书籍保留 {RETENTION_DAYS} 天后自动彻底清除
        </span>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-neutral-600 dark:text-neutral-400">加载中...</div>
        </div>
      ) : trashedBooks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto mb-3 w-fit rounded-full bg-neutral-100 p-3 dark:bg-neutral-800">
              <Trash2 size={24} className="text-neutral-500 dark:text-neutral-500" />
            </div>
            <p className="text-neutral-600 text-sm dark:text-neutral-400">回收站是空的</p>
            <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-500">
              删除的书籍会在这里保留 {RETENTION_DAYS} 天，期间可随时恢复
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 pb-8">
          <div className="space-y-2">
            {trashedBooks.map((book) => (
              <div key={book.id} className="flex items-center gap-3 rounded-lg border p-3">
                {book.coverUrl ? (
                  <img src={book.coverUrl} alt={book.title} className="h-16 w-12 flex-shrink-0 rounded object-cover" />
                ) : (
                  <div className="flex h-16 w-12 flex-shrink-0 items-center justify-center rounded bg-neutral-100 dark:bg-neutral-800">
                    <span className="text-lg text-neutral-400">📖</span>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h4 className="line-clamp-1 font-medium text-neutral-900 text-sm dark:text-neutral-100">
                    {book.title}
                  </h4>
                  <p className="line-clamp-1 text-neutral-600 text-xs dark:text-neutral-400">
                    {book.author || "未知作者"}
                  </p>
                  <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-500">
                    删除于 {dayjs(book.trashedAt).format("YYYY-MM-DD HH:mm")} · 剩余 {remainingDays(book.trashedAt)} 天
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleRestore(book)}>
                    恢复
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handlePurge(book)}>
                    彻底删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
