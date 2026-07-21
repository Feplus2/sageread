import type { Thread } from "@/types/thread";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { UIMessage } from "ai";
import dayjs from "dayjs";
import { toast } from "sonner";
import { EXPORT_HTML_CSS, buildExportHeaderHtml, buildMessagesHtml } from "./export-thread-html";
import { type ExportMeta, resolveBookTitle, toSafeFileName } from "./export-thread-markdown";

const MAX_HEIGHT = 16000; // Chromium 画布高度上限 16384，留余量
const RENDER_WIDTH = 880;
const RENDER_SCALE = 2; // 2x 渲染提升清晰度

/**
 * 迷你 html-to-image：把导出 HTML 填进离屏隐藏容器（有布局、不可见），
 * 用 XMLSerializer 序列化进 SVG foreignObject，再绘制到 canvas。
 * 内容全内联无外部资源，canvas 不会被污染。
 */
export async function renderMessagesToPngBlob(
  messages: UIMessage[],
  meta: { title: string; bookTitle?: string },
): Promise<Blob> {
  // 离屏定位放在外层包装元素上；被序列化的容器自身不能有 left:-9999px，
  // 否则 SVG 视口内同样偏移 -9999px 渲染空白（已踩坑验证）
  const offscreen = document.createElement("div");
  offscreen.style.cssText = "position:absolute;left:-9999px;top:0;";
  const container = document.createElement("div");
  // 容器内联 body 等价样式（EXPORT_HTML_CSS 里的 body 选择器对 div 不生效）
  container.style.cssText = `width:${RENDER_WIDTH}px;background:#f5f1e8;color:#3a3226;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;padding:32px 16px;`;
  container.innerHTML = `<style>${EXPORT_HTML_CSS}</style><div class="container">${buildExportHeaderHtml({
    title: meta.title,
    bookTitle: meta.bookTitle,
    messageCount: messages.length,
  })}<main>${buildMessagesHtml(messages)}</main></div>`;
  offscreen.appendChild(container);
  document.body.appendChild(offscreen);

  try {
    // 高度超限：从尾部移除消息直到放得下，再补截断提示
    if (container.offsetHeight > MAX_HEIGHT) {
      const messageEls = Array.from(container.querySelectorAll(".message"));
      for (let i = messageEls.length - 1; i >= 0 && container.offsetHeight > MAX_HEIGHT - 60; i--) {
        messageEls[i].remove();
      }
      const notice = document.createElement("div");
      notice.style.cssText = "text-align:center;font-size:12px;color:#8a7c60;padding:12px 0;";
      notice.textContent = "对话过长，已截断（完整内容请导出 Markdown）";
      container.querySelector("main")?.appendChild(notice);
    }

    const height = Math.min(container.offsetHeight, MAX_HEIGHT);
    const serialized = new XMLSerializer().serializeToString(container);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_WIDTH}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    // 注意用 data: URL 而非 blob: URL——blob 加载的 foreignObject SVG 会被 Chromium 标记污染，无法 toBlob
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG 图像加载失败"));
      el.src = svgUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = RENDER_WIDTH * RENDER_SCALE;
    canvas.height = height * RENDER_SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    ctx.scale(RENDER_SCALE, RENDER_SCALE);
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("图片生成失败");
    return blob;
  } finally {
    offscreen.remove();
  }
}

/* ------------------------------------------------------------
 * 以下为纯 Canvas 手绘实现（foreignObject 路径失败时的回落），请勿删除
 * ---------------------------------------------------------- */

const PADDING = 40;
const CONTENT_WIDTH = RENDER_WIDTH - PADDING * 2;
const BUBBLE_MAX_WIDTH = 640;
const BUBBLE_PADDING_X = 16;
const BUBBLE_PADDING_Y = 12;
const BADGE_HEIGHT = 20;
const LINE_HEIGHT = 22;

const FONT_BODY = "14px 'Segoe UI', 'Microsoft YaHei', sans-serif";
const FONT_TITLE = "bold 20px 'Segoe UI', 'Microsoft YaHei', sans-serif";
const FONT_META = "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
const FONT_BADGE = "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";

interface DrawBlock {
  kind: "text" | "quote";
  lines: string[];
}

interface LayoutMessage {
  isUser: boolean;
  blocks: DrawBlock[];
}

/** 逐字断行：中文按字断、英文到边也按字断，measureText 实测宽度 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line += char;
      }
    }
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

function collectBlocks(message: UIMessage, ctx: CanvasRenderingContext2D): DrawBlock[] {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const blocks: DrawBlock[] = [];
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    if (text) {
      blocks.push({ kind: "text", lines: wrapText(ctx, text, BUBBLE_MAX_WIDTH - BUBBLE_PADDING_X * 2) });
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
      const quote = String(part.text ?? "").trim();
      if (quote) {
        blocks.push({ kind: "quote", lines: wrapText(ctx, quote, CONTENT_WIDTH - 32) });
      }
    }
  }

  flushText();
  return blocks;
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
  ctx.fill();
}

function blockHeight(block: DrawBlock): number {
  if (block.kind === "quote") {
    return block.lines.length * LINE_HEIGHT + 16;
  }
  return block.lines.length * LINE_HEIGHT + BUBBLE_PADDING_Y * 2;
}

/** 纯 Canvas 手绘渲染（回落路径）：输出为源码级排版，仅在 foreignObject 不可用时使用 */
async function renderMessagesToPngBlobFallback(
  messages: UIMessage[],
  meta: { title: string; bookTitle?: string },
): Promise<Blob> {
  const title = meta.title || "未命名对话";
  const metaLine = [meta.bookTitle ? `《${meta.bookTitle}》` : "", dayjs().format("YYYY-MM-DD HH:mm:ss")].filter(
    Boolean,
  );

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  if (!measureCtx) throw new Error("无法创建画布上下文");
  measureCtx.font = FONT_BODY;

  const layoutMessages: LayoutMessage[] = messages
    .map((message) => ({
      isUser: message.role === "user",
      blocks: collectBlocks(message, measureCtx),
    }))
    .filter((m) => m.blocks.length > 0);

  const HEADER_HEIGHT = 84;
  const FOOTER_HEIGHT = 48;
  let y = PADDING + HEADER_HEIGHT;
  let truncated = false;
  const visibleMessages: LayoutMessage[] = [];

  for (const message of layoutMessages) {
    const messageHeight =
      BADGE_HEIGHT + 6 + message.blocks.reduce((sum, block) => sum + blockHeight(block) + 8, 0) + 12;
    if (y + messageHeight > MAX_HEIGHT - FOOTER_HEIGHT) {
      truncated = true;
      break;
    }
    visibleMessages.push(message);
    y += messageHeight;
  }

  const totalHeight = Math.min(y + FOOTER_HEIGHT, MAX_HEIGHT);

  const canvas = document.createElement("canvas");
  canvas.width = RENDER_WIDTH;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");

  ctx.fillStyle = "#f7f4ee";
  ctx.fillRect(0, 0, RENDER_WIDTH, totalHeight);
  ctx.textBaseline = "top";

  let cursorY = PADDING;
  ctx.font = FONT_TITLE;
  ctx.fillStyle = "#3a3226";
  ctx.fillText(title, PADDING, cursorY, CONTENT_WIDTH);
  cursorY += 30;
  ctx.font = FONT_META;
  ctx.fillStyle = "#8a7c60";
  ctx.fillText(metaLine.join("  ·  "), PADDING, cursorY, CONTENT_WIDTH);
  cursorY += 24;
  ctx.strokeStyle = "#ddd3b8";
  ctx.beginPath();
  ctx.moveTo(PADDING, cursorY);
  ctx.lineTo(RENDER_WIDTH - PADDING, cursorY);
  ctx.stroke();
  cursorY += 30;

  ctx.font = FONT_BODY;
  for (const message of visibleMessages) {
    const badgeText = message.isUser ? "用户" : "AI";
    ctx.font = FONT_BADGE;
    const badgeWidth = ctx.measureText(badgeText).width + 16;
    const badgeX = message.isUser ? RENDER_WIDTH - PADDING - badgeWidth : PADDING;
    ctx.fillStyle = "#a05a2c";
    drawRoundRect(ctx, badgeX, cursorY, badgeWidth, BADGE_HEIGHT, 9);
    ctx.fillStyle = "#fffdf7";
    ctx.fillText(badgeText, badgeX + 8, cursorY + 4);
    cursorY += BADGE_HEIGHT + 6;
    ctx.font = FONT_BODY;

    for (const block of message.blocks) {
      if (block.kind === "quote") {
        const height = blockHeight(block);
        ctx.fillStyle = "rgba(160, 90, 44, 0.08)";
        drawRoundRect(ctx, PADDING, cursorY, CONTENT_WIDTH, height, 6);
        ctx.fillStyle = "#a05a2c";
        ctx.fillRect(PADDING, cursorY, 3, height);
        ctx.fillStyle = "#6b5c42";
        block.lines.forEach((line, i) => {
          ctx.fillText(line, PADDING + 14, cursorY + 8 + i * LINE_HEIGHT);
        });
        cursorY += height + 8;
        continue;
      }

      const maxLineWidth = Math.max(...block.lines.map((line) => ctx.measureText(line).width), 0);
      const bubbleWidth = Math.min(maxLineWidth + BUBBLE_PADDING_X * 2, BUBBLE_MAX_WIDTH);
      const bubbleHeight = blockHeight(block);
      const bubbleX = message.isUser ? RENDER_WIDTH - PADDING - bubbleWidth : PADDING;

      ctx.fillStyle = message.isUser ? "#e9d6a6" : "#fffdf7";
      drawRoundRect(ctx, bubbleX, cursorY, bubbleWidth, bubbleHeight, 12);
      if (!message.isUser) {
        ctx.strokeStyle = "#e5dcc4";
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(bubbleX, cursorY, bubbleWidth, bubbleHeight, 12);
        } else {
          ctx.rect(bubbleX, cursorY, bubbleWidth, bubbleHeight);
        }
        ctx.stroke();
      }

      ctx.fillStyle = "#3a3226";
      block.lines.forEach((line, i) => {
        ctx.fillText(line, bubbleX + BUBBLE_PADDING_X, cursorY + BUBBLE_PADDING_Y + i * LINE_HEIGHT);
      });
      cursorY += bubbleHeight + 8;
    }

    cursorY += 12;
  }

  ctx.font = FONT_META;
  ctx.fillStyle = "#8a7c60";
  const footerText = truncated ? "对话过长，已截断（完整内容请导出 Markdown）" : "由 SageRead 导出";
  const footerWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (RENDER_WIDTH - footerWidth) / 2, totalHeight - FOOTER_HEIGHT + 14);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("图片生成失败");
  return blob;
}

/**
 * 弹出保存对话框并将一组消息渲染为 PNG 长图。
 * 主路径为 HTML 渲染（排版与 HTML 导出一致），失败时回落纯 Canvas 手绘。
 */
export async function exportMessagesToImage(messages: UIMessage[], meta: ExportMeta): Promise<boolean> {
  if (!buildMessagesHtml(messages)) {
    toast.error("没有可导出的内容");
    return false;
  }

  const bookTitle = await resolveBookTitle(meta.bookId);

  let blob: Blob;
  try {
    blob = await renderMessagesToPngBlob(messages, { title: meta.title, bookTitle });
  } catch (error) {
    console.warn("[导出图片] foreignObject 渲染失败，回落纯 Canvas 手绘:", error);
    try {
      blob = await renderMessagesToPngBlobFallback(messages, { title: meta.title, bookTitle });
    } catch (fallbackError) {
      console.error("导出对话失败:", fallbackError);
      toast.error("导出对话失败");
      return false;
    }
  }

  try {
    const path = await save({
      defaultPath: `${toSafeFileName(meta.title)}.png`,
      filters: [
        {
          name: "PNG 图片",
          extensions: ["png"],
        },
      ],
    });

    // 用户取消保存，不视为失败
    if (!path) {
      return false;
    }

    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    toast.success(meta.successText ?? "对话导出成功");
    return true;
  } catch (error) {
    console.error("导出对话失败:", error);
    toast.error("导出对话失败");
    return false;
  }
}

/**
 * 导出整个对话为 PNG 长图
 */
export async function exportThreadToImage(thread: Thread): Promise<boolean> {
  return exportMessagesToImage(thread.messages, {
    title: thread.title || "未命名对话",
    bookId: thread.book_id,
  });
}
