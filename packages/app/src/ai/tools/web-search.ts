import { invoke } from "@tauri-apps/api/core";
import { useWebSearchStore } from "@/store/web-search-store";
import { tool } from "ai";
import { z } from "zod";

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchTool = tool({
  description: `联网搜索实时网络信息（基于 DuckDuckGo，免 API key）。

🎯 **适用场景**：
• 用户询问书籍内容之外的实时信息、新闻、资料
• 需要查证作者背景、出版动态、相关评论等外部知识
• 当前书籍索引无法回答、需要互联网补充的问题

📊 **返回内容**：
网页搜索结果列表，每条包含标题、链接和内容摘要。请基于摘要作答并注明来源链接。`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户想了解这本书作者的最新动态'"),
    question: z.string().min(1).describe("要搜索的关键词或问题，应精炼为适合搜索引擎的查询语句"),
    maxResults: z.number().int().min(1).max(10).default(6).describe("返回的结果数量，默认6条"),
  }),

  execute: async ({
    reasoning,
    question,
    maxResults,
  }: {
    reasoning: string;
    question: string;
    maxResults?: number;
  }) => {
    try {
      const engine = useWebSearchStore.getState().engine;
      const results = await invoke<WebSearchResult[]>("web_search", {
        query: question.trim(),
        maxResults: maxResults || 6,
        engine,
      });

      return {
        results,
        meta: {
          reasoning,
          question,
          count: results.length,
        },
      };
    } catch (error) {
      throw new Error(`网络搜索失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
