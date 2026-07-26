import type { PreviewFormat } from "@/store/preview-store";

/**
 * 检测代码块是否可预览，返回对应的预览格式
 */
export function detectPreviewFormat(language: string, code: string): PreviewFormat | null {
  const lang = language.toLowerCase().trim();

  if (lang === "html" || lang === "htm") {
    return "html";
  }

  if (lang === "svg") {
    return "svg";
  }

  if (lang === "mermaid" || lang === "mmd") {
    return "mermaid";
  }

  if (lang === "jsx" || lang === "tsx" || lang === "react") {
    return "react";
  }

  // 无语言标记但内容看起来像完整 HTML 文档
  if (!lang || lang === "plaintext") {
    const trimmed = code.trim();
    if (
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<!doctype") ||
      trimmed.startsWith("<html")
    ) {
      return "html";
    }
    if (trimmed.startsWith("<svg")) {
      return "svg";
    }
  }

  return null;
}

/**
 * 快捷判断代码块是否可预览
 */
export function isPreviewable(language: string, code: string): boolean {
  return detectPreviewFormat(language, code) !== null;
}

/**
 * 将 HTML 代码包装为完整的 srcdoc 文档
 * 如果已经是完整文档则直接使用，否则补全 html/head/body 结构
 */
export function buildHtmlSrcdoc(code: string, isDark = false): string {
  const trimmed = code.trim();
  const isFullDocument =
    trimmed.toLowerCase().includes("<!doctype") ||
    trimmed.toLowerCase().includes("<html");

  if (isFullDocument) {
    return trimmed;
  }

  const darkStyles = isDark
    ? `
  :root { color-scheme: dark; }
  body { background: #1a1a1a; color: #e5e5e5; }`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; }${darkStyles}
</style>
</head>
<body>
${trimmed}
</body>
</html>`;
}

/**
 * 将 SVG 代码包装为居中显示的 HTML 文档
 */
export function buildSvgSrcdoc(svg: string, isDark = false): string {
  const bg = isDark ? "#1a1a1a" : "#fff";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: ${bg}; overflow: auto; }
  svg { max-width: 100%; max-height: 100%; }
</style>
</head>
<body>
${svg.trim()}
</body>
</html>`;
}

/**
 * 根据语言获取文件扩展名
 */
export function getExtensionForLanguage(language: string): string {
  const map: Record<string, string> = {
    html: "html",
    htm: "html",
    svg: "svg",
    mermaid: "mmd",
    mmd: "mmd",
    jsx: "jsx",
    tsx: "tsx",
    react: "jsx",
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    css: "css",
    json: "json",
    python: "py",
    py: "py",
    markdown: "md",
    md: "md",
  };
  return map[language.toLowerCase()] || "txt";
}

/**
 * 获取预览格式的显示标题
 */
export function getPreviewTitle(format: PreviewFormat): string {
  const titles: Record<PreviewFormat, string> = {
    html: "HTML Preview",
    svg: "SVG Preview",
    mermaid: "Mermaid Diagram",
    react: "React Preview",
  };
  return titles[format];
}
