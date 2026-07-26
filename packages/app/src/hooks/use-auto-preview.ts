import { detectPreviewFormat, getPreviewTitle } from "@/lib/preview-utils";
import { usePreviewStore } from "@/store/preview-store";
import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";

/**
 * 从 Markdown 文本中提取代码块
 */
function extractCodeBlocks(text: string): { language: string; code: string }[] {
  const blocks: { language: string; code: string }[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] || "plaintext",
      code: match[2].trimEnd(),
    });
  }

  return blocks;
}

/**
 * AI 回复完成后，自动检测并打开可预览代码块的预览面板
 */
export function useAutoPreview(messages: UIMessage[], status: string) {
  const prevStatusRef = useRef(status);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    // 仅在 streaming → ready 转换时触发
    if (prevStatus !== "streaming" || status !== "ready") return;
    if (messages.length === 0) return;

    // 取最后一条 assistant 消息
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    // 从所有 text parts 中提取代码块
    const textContent = (lastMessage.parts ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text ?? "")
      .join("");

    if (!textContent) return;

    const codeBlocks = extractCodeBlocks(textContent);

    // 从后往前找第一个可预览的代码块（通常最后一个是主要输出）
    for (let i = codeBlocks.length - 1; i >= 0; i--) {
      const block = codeBlocks[i];
      const format = detectPreviewFormat(block.language, block.code);
      if (format) {
        usePreviewStore.getState().openPreview({
          id: `auto-${lastMessage.id}-${i}`,
          content: block.code,
          language: block.language,
          format,
          title: getPreviewTitle(format),
        });
        return;
      }
    }
  }, [status, messages]);
}
