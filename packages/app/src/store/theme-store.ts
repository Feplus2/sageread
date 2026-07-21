import {
  type GlobalThemeInfo,
  injectGlobalThemeCss,
  listGlobalThemes,
  loadGlobalThemeCss,
} from "@/services/global-theme-service";
import type { ReaderBackground } from "@/styles/reader-scenes";
import type { CustomTheme, Palette, ThemeMode } from "@/styles/themes";
import type { SystemSettings } from "@/types/settings";
import { type ThemeCode, getThemeCode } from "@/utils/style";
import { create } from "zustand";

interface ThemeState {
  themeMode: ThemeMode;
  themeColor: string;
  systemIsDarkMode: boolean;
  themeCode: ThemeCode;
  isDarkMode: boolean;
  systemUIVisible: boolean;
  statusBarHeight: number;
  systemUIAlwaysHidden: boolean;
  autoScroll: boolean;
  swapSidebars: boolean;
  globalTheme: string | null;
  availableGlobalThemes: GlobalThemeInfo[];
  readerBackground: ReaderBackground | null;
  setSystemUIAlwaysHidden: (hidden: boolean) => void;
  setStatusBarHeight: (height: number) => void;
  showSystemUI: () => void;
  dismissSystemUI: () => void;
  getIsDarkMode: () => boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setThemeColor: (color: string) => void;
  setGlobalTheme: (name: string | null) => Promise<void>;
  refreshGlobalThemes: () => Promise<void>;
  setReaderBackground: (bg: ReaderBackground | null) => void;
  setAutoScroll: (enabled: boolean) => void;
  setSwapSidebars: (enabled: boolean) => void;
  updateAppTheme: (color: keyof Palette) => void;
  saveCustomTheme: (settings: SystemSettings, theme: CustomTheme, isDelete?: boolean) => void;
}

const getInitialThemeColor = (): string => {
  if (typeof window !== "undefined" && localStorage) {
    return localStorage.getItem("themeColor") || "default";
  }
  return "default";
};

// localStorage 同步读取，避免 provider-store 异步恢复带来的闪烁问题
const getInitialGlobalTheme = (): string | null => {
  if (typeof window !== "undefined" && localStorage) {
    return localStorage.getItem("globalTheme") || null;
  }
  return null;
};

// 阅读区背景配置（纯色/场景/自定义图片），JSON 持久化
const getInitialReaderBackground = (): ReaderBackground | null => {
  try {
    if (typeof window !== "undefined" && localStorage) {
      const raw = localStorage.getItem("readerBackground");
      return raw ? (JSON.parse(raw) as ReaderBackground) : null;
    }
  } catch {
    // 损坏的配置按未设置处理
  }
  return null;
};

const getInitialThemeMode = (): ThemeMode => {
  if (typeof window !== "undefined" && localStorage) {
    return (localStorage.getItem("themeMode") as ThemeMode) || "auto";
  }
  return "auto";
};

const getInitialAutoScroll = (): boolean => {
  if (typeof window !== "undefined" && localStorage) {
    const stored = localStorage.getItem("autoScroll");
    return stored !== null ? stored === "true" : true; // 默认启用自动滚动
  }
  return true;
};

const getInitialSwapSidebars = (): boolean => {
  if (typeof window !== "undefined" && localStorage) {
    const stored = localStorage.getItem("swapSidebars");
    return stored !== null ? stored === "true" : false;
  }
  return false;
};

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialThemeMode = getInitialThemeMode();
  const initialAutoScroll = getInitialAutoScroll();
  const initialSwapSidebars = getInitialSwapSidebars();
  const initialThemeColor = getInitialThemeColor();
  const initialGlobalTheme = getInitialGlobalTheme();
  const initialReaderBackground = getInitialReaderBackground();

  console.log("initialThemeMode", initialThemeMode);
  console.log("initialAutoScroll", initialAutoScroll);
  console.log("initialSwapSidebars", initialSwapSidebars);

  const systemIsDarkMode = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDarkMode = initialThemeMode === "dark" || (initialThemeMode === "auto" && systemIsDarkMode);
  const themeCode = getThemeCode();

  if (typeof window !== "undefined") {
    document.documentElement.className = document.documentElement.className
      .split(" ")
      .filter((cls) => cls !== "dark")
      .join(" ");

    if (isDarkMode) {
      document.documentElement.classList.add("dark");
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      const mode = get().themeMode;
      const isDarkMode = mode === "dark" || (mode === "auto" && mediaQuery.matches);
      set({ systemIsDarkMode: mediaQuery.matches, isDarkMode });
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
  }

  return {
    themeMode: initialThemeMode,
    themeColor: initialThemeColor,
    systemIsDarkMode,
    isDarkMode,
    themeCode,
    systemUIVisible: false,
    statusBarHeight: 24,
    systemUIAlwaysHidden: false,
    autoScroll: initialAutoScroll,
    swapSidebars: initialSwapSidebars,
    globalTheme: initialGlobalTheme,
    availableGlobalThemes: [],
    readerBackground: initialReaderBackground,
    showSystemUI: () => set({ systemUIVisible: true }),
    dismissSystemUI: () => set({ systemUIVisible: false }),
    setStatusBarHeight: (height: number) => set({ statusBarHeight: height }),
    setSystemUIAlwaysHidden: (hidden: boolean) => set({ systemUIAlwaysHidden: hidden }),
    getIsDarkMode: () => get().isDarkMode,
    setThemeMode: (mode) => {
      if (typeof window !== "undefined" && localStorage) {
        localStorage.setItem("themeMode", mode);
      }
      const isDarkMode = mode === "dark" || (mode === "auto" && get().systemIsDarkMode);

      // Apply theme classes to document element
      document.documentElement.className = document.documentElement.className
        .split(" ")
        .filter((cls) => cls !== "dark")
        .join(" ");

      if (isDarkMode) {
        document.documentElement.classList.add("dark");
      }

      set({ themeMode: mode, isDarkMode });
      set({ themeCode: getThemeCode() });
    },

    setThemeColor: (color) => {
      if (typeof window !== "undefined" && localStorage) {
        localStorage.setItem("themeColor", color);
      }
      set({ themeColor: color });
      set({ themeCode: getThemeCode() });
    },

    refreshGlobalThemes: async () => {
      const themes = await listGlobalThemes();
      set({ availableGlobalThemes: themes });
      // 重扫列表后重新注入当前主题，让刷新按钮能加载 CSS 文件的最新内容
      const current = get().globalTheme;
      if (current) {
        await get().setGlobalTheme(current);
      }
    },

    setReaderBackground: (bg) => {
      if (typeof window !== "undefined" && localStorage) {
        if (bg) {
          localStorage.setItem("readerBackground", JSON.stringify(bg));
        } else {
          localStorage.removeItem("readerBackground");
        }
      }
      set({ readerBackground: bg });
      set({ themeCode: getThemeCode() });
    },

    setGlobalTheme: async (name) => {
      if (typeof window !== "undefined" && localStorage) {
        if (name) {
          localStorage.setItem("globalTheme", name);
        } else {
          localStorage.removeItem("globalTheme");
        }
      }
      set({ globalTheme: name });

      if (!name) {
        // 选"默认"：移除注入的 <style>，恢复默认外观
        injectGlobalThemeCss(null);
        return;
      }

      // 同名时用户主题优先
      const entry =
        get().availableGlobalThemes.find((t) => t.name === name && t.source === "user") ??
        get().availableGlobalThemes.find((t) => t.name === name);

      if (!entry) {
        // 主题文件已被删除等情况：清除选择并回落默认主题
        console.warn(`[GlobalTheme] 主题不存在，回落默认主题: ${name}`);
        if (typeof window !== "undefined" && localStorage) {
          localStorage.removeItem("globalTheme");
        }
        set({ globalTheme: null });
        injectGlobalThemeCss(null);
        return;
      }

      const css = await loadGlobalThemeCss(entry);
      injectGlobalThemeCss(css);
    },

    setAutoScroll: (enabled) => {
      if (typeof window !== "undefined" && localStorage) {
        localStorage.setItem("autoScroll", enabled.toString());
      }
      set({ autoScroll: enabled });
    },
    setSwapSidebars: (enabled) => {
      if (typeof window !== "undefined" && localStorage) {
        localStorage.setItem("swapSidebars", enabled.toString());
      }
      set({ swapSidebars: enabled });
    },
    updateAppTheme: (color) => {
      const { palette } = get().themeCode;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette[color]);
    },
    saveCustomTheme: async (settings, theme, isDelete) => {
      const customThemes = settings.globalReadSettings.customThemes || [];
      const index = customThemes.findIndex((t) => t.name === theme.name);
      if (isDelete) {
        if (index > -1) {
          customThemes.splice(index, 1);
        }
      } else {
        if (index > -1) {
          customThemes[index] = theme;
        } else {
          customThemes.push(theme);
        }
      }
      settings.globalReadSettings.customThemes = customThemes;
      localStorage.setItem("customThemes", JSON.stringify(customThemes));
    },
  };
});
