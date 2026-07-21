import type { Thread } from "@/types/thread";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { UIMessage } from "ai";
import dayjs from "dayjs";
import { marked } from "marked";
import { toast } from "sonner";
import { type ExportMeta, resolveBookTitle, toSafeFileName } from "./export-thread-markdown";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 轻量净化：去掉 script/iframe 等危险标签、on* 事件属性和 javascript: 链接。
 * 项目无 DOMPurify 类依赖，此为正则级防护，内容来自用户自己的对话记录，威胁模型有限。
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed|form|link|meta|style)\b[\s\S]*?(<\/\s*\1\s*>|\/?>)/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>]*\2/gi, "$1=$2#$2");
}

/**
 * 导出文档的共享样式（HTML 导出与图片导出共用，单一事实源）
 */
export const EXPORT_HTML_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: #f5f1e8; color: #3a3226;
         font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; }
  .container { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #ddd3b8; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .meta { font-size: 13px; color: #8a7c60; }
  .meta span + span::before { content: " · "; }
  .message { margin-bottom: 16px; display: flex; flex-direction: column; }
  .message.user { align-items: flex-end; }
  .message.assistant { align-items: flex-start; }
  .role { font-size: 12px; color: #8a7c60; margin-bottom: 4px; padding: 0 4px; }
  .bubble { max-width: 88%; padding: 12px 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(60, 50, 30, 0.08); }
  .user .bubble { background: #e9d6a6; border-radius: 12px 12px 4px 12px; }
  .assistant .bubble { background: #fffdf7; border: 1px solid #e5dcc4; border-radius: 12px 12px 12px 4px; }
  .bubble > :first-child { margin-top: 0; }
  .bubble > :last-child { margin-bottom: 0; }
  blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #a05a2c;
               background: rgba(160, 90, 44, 0.07); color: #6b5c42; border-radius: 0 6px 6px 0; }
  pre { background: #3a2e1e; color: #f0e6d0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  code { font-family: Consolas, "Courier New", monospace; }
  p code, li code { background: rgba(160, 90, 44, 0.1); padding: 1px 5px; border-radius: 4px; font-size: 90%; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #ddd3b8; padding: 6px 10px; }
  th { background: #eee2c2; }
  img { max-width: 100%; }
  a { color: #a05a2c; }
  footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #ddd3b8;
           font-size: 12px; color: #8a7c60; text-align: center; }
`;

/**
 * 导出文档头（标题 + 元信息行），HTML 导出与图片导出共用
 */
export function buildExportHeaderHtml(meta: { title: string; bookTitle?: string; messageCount: number }): string {
  return `<header>
    <h1>${escapeHtml(meta.title || "未命名对话")}</h1>
    <div class="meta">
      ${meta.bookTitle ? `<span>书名：《${escapeHtml(meta.bookTitle)}》</span>` : ""}
      <span>导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}</span>
      <span>消息数：${meta.messageCount}</span>
    </div>
  </header>`;
}

/**
 * 将单条消息的 parts 渲染为 HTML 片段（text → marked，quote → blockquote）
 */
export function renderMessageHtml(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  let html = "";
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    if (text) {
      html += sanitizeHtml(marked.parse(text, { async: false }));
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
      const quote = escapeHtml(String(part.text ?? "")).replace(/\n/g, "<br>");
      if (quote.trim()) {
        html += `<blockquote>${quote}</blockquote>`;
      }
    }
  }

  flushText();
  return html;
}

/**
 * 将一组消息渲染为消息流 HTML（用户/AI 气泡分区）
 */
export function buildMessagesHtml(messages: UIMessage[]): string {
  return messages
    .map((message) => {
      const body = renderMessageHtml(message);
      if (!body) return "";
      const isUser = message.role === "user";
      return `<div class="message ${isUser ? "user" : "assistant"}">
  <div class="role">${isUser ? "用户" : "AI"}</div>
  <div class="bubble">${body}</div>
</div>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 将一组消息构建为自包含单文件 HTML 文档（样式全内联，无外部依赖）
 */
export function buildThreadHtml(messages: UIMessage[], meta: { title: string; bookTitle?: string }): string {
  const title = meta.title || "未命名对话";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_HTML_CSS}</style>
</head>
<body>
<div class="container">
  ${buildExportHeaderHtml({ title, bookTitle: meta.bookTitle, messageCount: messages.length })}
  <main>
${buildMessagesHtml(messages)}
  </main>
  <footer>由 SageRead 导出</footer>
</div>
</body>
</html>
`;
}

/**
 * 弹出保存对话框并将一组消息导出为自包含 HTML 文件
 */
export async function exportMessagesToHtml(messages: UIMessage[], meta: ExportMeta): Promise<boolean> {
  try {
    const exportable = messages.filter((m) => renderMessageHtml(m));
    if (exportable.length === 0) {
      toast.error("没有可导出的内容");
      return false;
    }

    const bookTitle = await resolveBookTitle(meta.bookId);
    const html = buildThreadHtml(exportable, { title: meta.title, bookTitle });

    const path = await save({
      defaultPath: `${toSafeFileName(meta.title)}.html`,
      filters: [
        {
          name: "HTML",
          extensions: ["html"],
        },
      ],
    });

    // 用户取消保存，不视为失败
    if (!path) {
      return false;
    }

    await writeTextFile(path, html);
    toast.success(meta.successText ?? "对话导出成功");
    return true;
  } catch (error) {
    console.error("导出对话失败:", error);
    toast.error("导出对话失败");
    return false;
  }
}

/**
 * 导出整个对话为自包含 HTML 文件
 */
export async function exportThreadToHtml(thread: Thread): Promise<boolean> {
  return exportMessagesToHtml(thread.messages, {
    title: thread.title || "未命名对话",
    bookId: thread.book_id,
  });
}
