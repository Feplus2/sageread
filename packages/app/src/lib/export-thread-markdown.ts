import { getBookById } from "@/services/book-service";
import type { Thread } from "@/types/thread";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { UIMessage } from "ai";
import dayjs from "dayjs";
import { toast } from "sonner";

/** 导出元信息：标题 + 书籍（用于解析书名），successText 可定制成功提示 */
export interface ExportMeta {
  title: string;
  bookId?: string | null;
  successText?: string;
}

/** 按 bookId 解析书名，失败返回 undefined（不阻断导出） */
export async function resolveBookTitle(bookId?: string | null): Promise<string | undefined> {
  if (!bookId) return undefined;
  const book = await getBookById(bookId).catch(() => null);
  return book?.title;
}

/** 文件名清洗：去掉文件系统非法字符 */
export function toSafeFileName(name: string, fallback = "未命名对话"): string {
  return name.replace(/[<>:"/\\|?*]/g, "").trim() || fallback;
}

/**
 * 将单条消息的 parts 渲染为 Markdown。
 * 只导出 text 和 quote part；reasoning / tool 等过程性 part 与聊天页的定位一致，不进入导出文档。
 */
export function renderMessageMarkdown(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const blocks: string[] = [];
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    if (text) {
      blocks.push(text);
    }
    textBuffer = "";
  };

  for (const part of parts as any[]) {
    if (part?.type === "text") {
      textBuffer += part.text ?? "";
      continue;
    }

    if (part?.type === "quote") {
      flushText();
      const quote = String(part.text ?? "")
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
      if (quote.trim()) {
        blocks.push(quote);
      }
    }
  }

  flushText();
  return blocks.join("\n\n");
}

/**
 * 将一组消息构建为 Markdown 文档（含元信息头）
 */
export function buildThreadMarkdown(messages: UIMessage[], meta: { title: string; bookTitle?: string }): string {
  const lines: string[] = [];

  lines.push(`# ${meta.title || "未命名对话"}`);
  lines.push("");
  if (meta.bookTitle) {
    lines.push(`- 书名：《${meta.bookTitle}》`);
  }
  lines.push(`- 导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  lines.push(`- 消息数：${messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of messages) {
    const body = renderMessageMarkdown(message);
    if (!body) continue;
    lines.push(message.role === "user" ? "## 🧑 用户" : "## 🤖 AI");
    lines.push("");
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 弹出保存对话框并将一组消息导出为 Markdown 文件
 */
export async function exportMessagesToMarkdown(messages: UIMessage[], meta: ExportMeta): Promise<boolean> {
  try {
    const exportable = messages.filter((m) => renderMessageMarkdown(m));
    if (exportable.length === 0) {
      toast.error("没有可导出的内容");
      return false;
    }

    const bookTitle = await resolveBookTitle(meta.bookId);
    const markdown = buildThreadMarkdown(exportable, { title: meta.title, bookTitle });

    const path = await save({
      defaultPath: `${toSafeFileName(meta.title)}.md`,
      filters: [
        {
          name: "Markdown",
          extensions: ["md"],
        },
      ],
    });

    // 用户取消保存，不视为失败
    if (!path) {
      return false;
    }

    await writeTextFile(path, markdown);
    toast.success(meta.successText ?? "对话导出成功");
    return true;
  } catch (error) {
    console.error("导出对话失败:", error);
    toast.error("导出对话失败");
    return false;
  }
}

/**
 * 导出整个对话为 Markdown 文件
 */
export async function exportThreadToMarkdown(thread: Thread): Promise<boolean> {
  return exportMessagesToMarkdown(thread.messages, {
    title: thread.title || "未命名对话",
    bookId: thread.book_id,
  });
}

/**
 * 导出单条消息为 Markdown 文件（含元信息头，标题 = 对话标题 + 消息序号）
 */
export async function exportMessageToMarkdown(
  message: UIMessage,
  options: { threadTitle?: string; bookId?: string | null; index: number },
): Promise<boolean> {
  const title = `${options.threadTitle || "未命名对话"}-第${options.index + 1}条`;
  return exportMessagesToMarkdown([message], {
    title,
    bookId: options.bookId,
    successText: "消息导出成功",
  });
}
