import { convertFileSrc } from "@tauri-apps/api/core";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";

const BACKGROUNDS_DIR = "reader-backgrounds";
const SUPPORTED_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

/**
 * 阅读区自定义背景目录（{appConfigDir}/reader-backgrounds），不存在时自动创建
 * 用 join() 拼路径：appConfigDir 在 Windows 带尾部分隔符，模板字符串会拼出 `\/` 畸形串
 */
export async function getReaderBackgroundsDir(): Promise<string> {
  const configDir = await appConfigDir();
  const dir = await join(configDir, BACKGROUNDS_DIR);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * 打开背景文件夹（先 ensure 目录存在）
 */
export async function openReaderBackgroundsDir(): Promise<void> {
  const dir = await getReaderBackgroundsDir();
  console.log("[ReaderBackground] 打开背景文件夹:", dir);
  await openPath(dir);
}

/**
 * 扫描背景目录里的图片文件（png/jpg/jpeg/webp），返回文件名列表
 */
export async function listReaderBackgrounds(): Promise<string[]> {
  try {
    const dir = await getReaderBackgroundsDir();
    const entries = await readDir(dir);
    return entries
      .filter((entry) => entry.isFile && SUPPORTED_EXTS.some((ext) => entry.name.toLowerCase().endsWith(ext)))
      .map((entry) => entry.name);
  } catch (error) {
    console.error("[ReaderBackground] 扫描背景图片失败:", error);
    return [];
  }
}

/**
 * 把背景图片文件名解析为可加载的 URL（asset 协议，scope 已在 tauri.conf 放开）
 * 注意：该 URL 会写入书籍渲染文档的 CSS；若 asset:// 在书籍 iframe 内不可加载，
 * 需要回落为读文件转 base64 data URI（勿缓存进 localStorage，体积太大）
 */
export async function resolveReaderBackgroundUrl(fileName: string): Promise<string> {
  const dir = await getReaderBackgroundsDir();
  return convertFileSrc(await join(dir, fileName));
}

/**
 * 预加载背景图片（浏览器解码缓存），切换背景时不再现场解码
 */
export function preloadImages(urls: string[]): void {
  for (const url of urls) {
    const img = new Image();
    img.src = url;
  }
}

export interface ReaderBackgroundSuggestion {
  /** 浅色模式：文字色 + 遮罩浓度 */
  fg: string;
  scrim: number;
  /** 深色模式：文字色 + 遮罩浓度 */
  darkFg: string;
  darkScrim: number;
}

/**
 * 分析自定义图片的平均亮度，按明暗两套模式推荐文字色与遮罩浓度。
 * 用 Blob URL 绘图（不用 asset://，避免 canvas 跨域污染），缩绘到 32x32 后按 Rec.601 算亮度。
 * 参数矩阵（遮罩色浅色模式为白、深色模式为黑，据此配文字色）：
 *   亮图：light=深字+0.45（微白罩），dark=浅字+0.6（深罩压暗）
 *   暗图：light=浅字+0.2（保留暗底氛围），dark=浅字+0.3（暗上微压）
 * 失败返回 null 由调用方保持现状。
 */
export async function analyzeReaderBackground(fileName: string): Promise<ReaderBackgroundSuggestion | null> {
  try {
    const dir = await getReaderBackgroundsDir();
    const bytes = await readFile(await join(dir, fileName));
    const blobUrl = URL.createObjectURL(new Blob([bytes]));

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("图片加载失败"));
        el.src = blobUrl;
      });

      // 缩绘到小画布，平均亮度用少量像素估算即可
      const size = 32;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, size, size);

      const { data } = ctx.getImageData(0, 0, size, size);
      let luminanceSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        luminanceSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      const brightness = luminanceSum / (data.length / 4) / 255;

      return brightness >= 0.55
        ? { fg: "#3a3226", scrim: 0.45, darkFg: "#e8e2d4", darkScrim: 0.6 }
        : { fg: "#e8e2d4", scrim: 0.2, darkFg: "#e8e2d4", darkScrim: 0.3 };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (error) {
    console.warn("[ReaderBackground] 分析图片亮度失败:", error);
    return null;
  }
}
