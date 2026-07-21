import { appConfigDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile } from "@tauri-apps/plugin-fs";

export interface GlobalThemeInfo {
  name: string;
  source: "builtin" | "user";
  /** 显示名：来自 CSS 首行注释的 @name 声明，缺省回退文件名 */
  label?: string;
}

// 内置主题清单：public/themes 下的文件无法运行时列目录，新增内置主题时在此登记（不含 .css 后缀）
const BUILTIN_THEMES = ["parchment"];

const USER_THEMES_DIR = "themes";

export const GLOBAL_THEME_STYLE_ID = "sageread-global-theme";

// 解析 CSS 文件开头注释里的 @name 声明，如 /* @name 羊皮纸 */
const THEME_NAME_RE = /^\s*\/\*\s*@name\s+([^*]+?)\s*\*\//;

export function parseThemeName(css: string): string | null {
  const match = THEME_NAME_RE.exec(css);
  return match?.[1]?.trim() || null;
}

/**
 * 用户主题目录（{appConfigDir}/themes），不存在时自动创建
 * 用 join() 拼路径：appConfigDir 在 Windows 带尾部分隔符，模板字符串会拼出 `\/` 畸形串
 */
export async function getUserThemesDir(): Promise<string> {
  const configDir = await appConfigDir();
  const themesDir = await join(configDir, USER_THEMES_DIR);
  if (!(await exists(themesDir))) {
    await mkdir(themesDir, { recursive: true });
  }
  return themesDir;
}

/**
 * 扫描全部可用全局主题：内置（清单登记）+ 用户（{appConfigDir}/themes/*.css）
 * 主题名即文件名（不含 .css 后缀）；同名时用户主题优先
 */
export async function listGlobalThemes(): Promise<GlobalThemeInfo[]> {
  const themes: GlobalThemeInfo[] = BUILTIN_THEMES.map((name) => ({ name, source: "builtin" as const }));

  try {
    const themesDir = await getUserThemesDir();
    const entries = await readDir(themesDir);
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".css")) continue;

      const name = entry.name.slice(0, -".css".length);
      const existing = themes.find((t) => t.name === name);
      if (existing) {
        existing.source = "user";
      } else {
        themes.push({ name, source: "user" });
      }
    }
  } catch (error) {
    console.error("[GlobalTheme] 扫描用户主题失败:", error);
  }

  // 读取各主题 CSS 首行注释解析 @name 显示名（文件少，逐个读开销可忽略）
  await Promise.all(
    themes.map(async (theme) => {
      const css = await loadGlobalThemeCss(theme);
      const label = css ? parseThemeName(css) : null;
      if (label) {
        theme.label = label;
      }
    }),
  );

  return themes;
}

/**
 * 读取主题 CSS 内容：用户主题从主题目录读取，内置主题从 public/themes fetch
 * 失败返回 null，由调用方回落为默认主题
 */
export async function loadGlobalThemeCss(theme: GlobalThemeInfo): Promise<string | null> {
  try {
    if (theme.source === "user") {
      const themesDir = await getUserThemesDir();
      return await readTextFile(await join(themesDir, `${theme.name}.css`));
    }

    // no-store：主题文件更新后必须拿到最新内容，不走 HTTP 缓存
    const response = await fetch(`/themes/${encodeURIComponent(theme.name)}.css`, { cache: "no-store" });
    return response.ok ? await response.text() : null;
  } catch (error) {
    console.error(`[GlobalTheme] 加载主题失败: ${theme.name}`, error);
    return null;
  }
}

/**
 * 将主题 CSS 注入 document.head 末尾的固定 <style> 标签；css 为 null 时移除（恢复默认主题）
 * 主题 CSS 只影响应用 UI（书架、侧边栏、AI 问答区等），不影响书籍 iframe 内部配色
 */
export function injectGlobalThemeCss(css: string | null): void {
  const styleEl = document.getElementById(GLOBAL_THEME_STYLE_ID) as HTMLStyleElement | null;

  if (!css) {
    styleEl?.remove();
    return;
  }

  if (styleEl) {
    styleEl.textContent = css;
  } else {
    const el = document.createElement("style");
    el.id = GLOBAL_THEME_STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
