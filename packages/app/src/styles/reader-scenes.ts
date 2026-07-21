/**
 * 阅读区背景配置模型与内置照片场景
 * 背景图渲染在应用侧容器（reader-viewer.tsx），与书籍文档内配色互不干扰
 */

export interface ReaderBackground {
  kind: "solid" | "scene" | "custom";
  /** kind=scene：内置场景 id */
  sceneId?: string;
  /** kind=custom：用户背景文件夹里的文件名 */
  fileName?: string;
  /** kind=custom：解析后的 asset URL 缓存（getThemeCode 为同步调用，无法实时取磁盘路径） */
  fileUrl?: string;
  /** 浅色模式文字色，缺省用场景推荐色/palette 文字色 */
  fg?: string;
  /** 深色模式文字色，缺省回落 fg */
  darkFg?: string;
  /** 浅色模式遮罩浓度 0~0.95，仅 scene/custom 有意义 */
  scrim?: number;
  /** 深色模式遮罩浓度，缺省回落 scrim */
  darkScrim?: number;
}

/** 场景在某一明暗模式下的呈现参数 */
export interface ReaderSceneModeParams {
  /** 遮罩浓度（遮罩色：浅色模式为白、深色模式为黑） */
  scrim: number;
  /** 推荐文字色 */
  fg: string;
}

export interface ReaderScene {
  id: string;
  label: string;
  /** 场景自身明暗（按实测亮度划分，面板标注用）：暗场景在深色模式配低遮罩让画面露出 */
  mode: "light" | "dark";
  /** 浅色模式呈现参数 */
  light: ReaderSceneModeParams;
  /** 深色模式呈现参数 */
  dark: ReaderSceneModeParams;
  /** 照片路径（public/backgrounds 下的 WebP），可直接用于 <img src>；CSS 里包一层 url() 即可 */
  uri: string;
}

// 内置照片场景：参数按各图实测亮度标定（遮罩色浅色模式为白、深色模式为黑）
export const readerScenes: ReaderScene[] = [
  {
    id: "parchment",
    label: "羊皮纸",
    mode: "light", // 亮度 0.87
    light: { scrim: 0.2, fg: "#4f3f2c" },
    dark: { scrim: 0.75, fg: "#e8e2d4" },
    uri: "/backgrounds/parchment.webp",
  },
  {
    id: "starry",
    label: "星空",
    mode: "dark", // 亮度 0.38
    light: { scrim: 0.55, fg: "#26304d" },
    dark: { scrim: 0.25, fg: "#e8e2d4" },
    uri: "/backgrounds/starry.webp",
  },
  {
    id: "mountains",
    label: "山脉",
    mode: "light", // 亮度 0.44
    light: { scrim: 0.45, fg: "#33402e" },
    dark: { scrim: 0.55, fg: "#e8e2d4" },
    uri: "/backgrounds/mountains.webp",
  },
  {
    id: "beach",
    label: "海滩",
    mode: "light", // 亮度 0.57
    light: { scrim: 0.4, fg: "#3d3830" },
    dark: { scrim: 0.6, fg: "#e8e2d4" },
    uri: "/backgrounds/beach.webp",
  },
  {
    id: "flowers",
    label: "花卉",
    mode: "dark", // 亮度 0.16
    light: { scrim: 0.6, fg: "#2e2a1f" },
    dark: { scrim: 0.2, fg: "#e8e2d4" },
    uri: "/backgrounds/flowers.webp",
  },
];

export const getReaderScene = (sceneId: string | undefined): ReaderScene | undefined =>
  sceneId ? readerScenes.find((scene) => scene.id === sceneId) : undefined;
