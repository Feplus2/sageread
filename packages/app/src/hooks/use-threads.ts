import { deleteThread, editThread, getAllThreads, getThreadById, getThreadsBybookId } from "@/services/thread-service";
import { generateThreadTitleWithAI } from "@/services/thread-title-service";
import { useThreadStore } from "@/store/thread-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

interface UseThreadsProps {
  bookId?: string | null;
}

export const useThreads = ({ bookId }: UseThreadsProps = {}) => {
  const queryClient = useQueryClient();

  // 获取 threads 列表
  const {
    data: threads,
    error,
    isLoading,
    status,
  } = useQuery({
    queryKey: ["threads", bookId],
    queryFn: async () => {
      return bookId ? await getThreadsBybookId(bookId) : await getAllThreads();
    },
  });

  // 删除 thread
  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      try {
        await deleteThread(threadId);
        toast.success("对话删除成功");

        // 刷新 threads 列表
        queryClient.invalidateQueries({ queryKey: ["threads", bookId] });
      } catch (error) {
        console.error("删除对话失败:", error);
        toast.error("删除对话失败");
        throw error;
      }
    },
    [queryClient, bookId],
  );

  // 重命名 thread
  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      try {
        const updatedThread = await editThread(threadId, { title });
        toast.success("对话重命名成功");

        // 若重命名的是当前对话，同步更新 store
        const { currentThread, setCurrentThread } = useThreadStore.getState();
        if (currentThread?.id === threadId) {
          setCurrentThread(updatedThread);
        }

        // 刷新所有 threads 列表
        queryClient.invalidateQueries({ queryKey: ["threads"] });
      } catch (error) {
        console.error("重命名对话失败:", error);
        toast.error("重命名对话失败");
        throw error;
      }
    },
    [queryClient],
  );

  // AI 重命名 thread（基于当前全部对话内容，手动触发）
  const handleAiRenameThread = useCallback(
    async (threadId: string) => {
      const toastId = toast.loading("正在生成标题...");
      try {
        const thread = await getThreadById(threadId);
        if (!thread.messages?.length) {
          toast.error("对话为空，无法生成标题", { id: toastId });
          return;
        }

        const title = await generateThreadTitleWithAI(thread.messages);
        if (!title) {
          throw new Error("未能生成标题");
        }

        const updatedThread = await editThread(threadId, { title });

        // 若重命名的是当前对话，同步更新 store
        const { currentThread, setCurrentThread } = useThreadStore.getState();
        if (currentThread?.id === threadId) {
          setCurrentThread(updatedThread);
        }

        // 刷新所有 threads 列表
        queryClient.invalidateQueries({ queryKey: ["threads"] });
        toast.success(`已重命名为「${title}」`, { id: toastId });
      } catch (error) {
        console.error("AI 重命名失败:", error);
        toast.error("AI 重命名失败", { id: toastId });
      }
    },
    [queryClient],
  );

  return {
    // 查询相关
    threads: threads ?? [],
    error,
    isLoading,
    status,

    // 操作相关
    handleDeleteThread,
    handleRenameThread,
    handleAiRenameThread,
  };
};
