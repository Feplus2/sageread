import { createModelInstance, getUtilityModel } from "@/ai/providers/factory";
import { type UIMessage, generateText } from "ai";

// 防御性长度上限，prompt 中要求的是 10 字以内
const MAX_TITLE_LENGTH = 20;

function extractText(message: UIMessage | undefined, limit: number): string {
  if (!message) return "";
  const text = (message.parts ?? [])
    .map((part: any) => (part?.type === "text" ? part.text : ""))
    .join("")
    .trim();
  return text.slice(0, limit);
}

/**
 * 使用AI为对话生成简短标题，失败时返回 null（由调用方决定如何提示）
 * 基于首问首答；对话超过一轮时附加最近一轮问答摘录，让标题反映整体内容
 */
export async function generateThreadTitleWithAI(
  messages: UIMessage[],
  selectedModel?: { providerId: string; modelId: string },
): Promise<string | null> {
  try {
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");
    const userText = extractText(firstUser, 200);
    const assistantText = extractText(firstAssistant, 500);
    if (!userText && !assistantText) return null;

    // 超过一轮对话时，附加最近一轮问答的摘录
    let latestUserText = "";
    let latestAssistantText = "";
    if (messages.length > 2) {
      latestUserText = extractText(
        messages.findLast((m) => m.role === "user"),
        200,
      );
      latestAssistantText = extractText(
        messages.findLast((m) => m.role === "assistant"),
        300,
      );
    }

    let modelConfig = selectedModel;
    if (!modelConfig) {
      // 显式传参优先，否则用辅助模型（未配置时回落当前聊天模型）
      const utilityModel = getUtilityModel();
      if (!utilityModel) return null;
      modelConfig = {
        providerId: utilityModel.providerId,
        modelId: utilityModel.modelId,
      };
    }

    const modelInstance = createModelInstance(modelConfig.providerId, modelConfig.modelId);

    const { text } = await generateText({
      model: modelInstance,
      prompt: buildTitlePrompt(userText, assistantText, latestUserText, latestAssistantText),
      maxOutputTokens: 30,
      temperature: 0.3,
    });

    return sanitizeTitle(text);
  } catch (error) {
    console.warn("AI生成对话标题失败:", error);
    return null;
  }
}

/**
 * 构建对话标题生成的提示词
 */
function buildTitlePrompt(
  userText: string,
  assistantText: string,
  latestUserText?: string,
  latestAssistantText?: string,
): string {
  const hasLatest = !!(latestUserText || latestAssistantText);
  if (!hasLatest) {
    return `请根据以下阅读对话的内容，为这段对话起一个简短的标题。

用户提问：${userText || "（无）"}

AI回答：${assistantText || "（无）"}

要求：
1. 标题不超过10个字
2. 概括对话的核心主题
3. 只输出标题本身，不要引号、不要标点结尾、不要任何解释`;
  }

  return `请根据以下阅读对话的内容，为这段对话起一个简短的标题。

对话开头：
用户提问：${userText || "（无）"}
AI回答：${assistantText || "（无）"}

最近内容：
用户提问：${latestUserText || "（无）"}
AI回答：${latestAssistantText || "（无）"}

以上是该对话的开头和最近内容，请基于对话的整体内容起标题。

要求：
1. 标题不超过10个字
2. 概括对话的核心主题
3. 只输出标题本身，不要引号、不要标点结尾、不要任何解释`;
}

/**
 * 清洗AI输出：取首行、去引号、去结尾标点、限制长度
 */
function sanitizeTitle(rawText: string): string | null {
  const firstLine = rawText.trim().split("\n")[0]?.trim() ?? "";
  const cleaned = firstLine
    .replace(/^[\s"'“”‘’「」『』《》<>#*-]+|[\s"'“”‘’「」『』《》<>]+$/g, "")
    .replace(/[。！？!?.…；;，,、：:]+$/g, "")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}
