import { getBookById } from "@/services/book-service";
import type { Thread } from "@/types/thread";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { UIMessage } from "ai";
import dayjs from "dayjs";
import { toast } from "sonner";

/**
 * 将单条消息的 parts 渲染为 Markdown。
 * 只导出 text 和 quote part；reasoning / tool 等过程性 part 与聊天页的定位一致，不进入导出文档。
 */
function renderMessageMarkdown(message: UIMessage): string {
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
        .map((line: string) => `> ${line}`.trimEnd())
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
 * 将整个对话构建为 Markdown 文档（含元信息头）
 */
export function buildThreadMarkdown(thread: Thread, bookTitle?: string): string {
  const lines: string[] = [];

  lines.push(`# ${thread.title || "未命名对话"}`);
  lines.push("");
  if (bookTitle) {
    lines.push(`- 书名：《${bookTitle}》`);
  }
  lines.push(`- 导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}`);
  lines.push(`- 消息数：${thread.messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of thread.messages) {
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
 * 弹出保存对话框并将对话导出为 Markdown 文件
 */
export async function exportThreadToMarkdown(thread: Thread): Promise<boolean> {
  try {
    const book = thread.book_id ? await getBookById(thread.book_id).catch(() => null) : null;
    const markdown = buildThreadMarkdown(thread, book?.title);

    const safeFileName = (thread.title || "未命名对话").replace(/[<>:"/\\|?*]/g, "").trim() || "未命名对话";

    const path = await save({
      defaultPath: `${safeFileName}.md`,
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
    toast.success("对话导出成功");
    return true;
  } catch (error) {
    console.error("导出对话失败:", error);
    toast.error("导出对话失败");
    return false;
  }
}
