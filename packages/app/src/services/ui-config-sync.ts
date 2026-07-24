/**
 * L2 UI 配置同步：背景选择状态 + 辅助模型选择
 * 云端文件 sageread-sync/ui-config.json，整文件 LWW（按 updated_at 大者采纳）
 * 安全红线：只含 utilityModel（仅 id/名称）与 readerBackground（剔除 fileUrl），
 * 绝不同步 modelProviders（含 apiKey）。
 *
 * 变更检测采用"值对比"而非订阅：每轮同步对比当前配置值与上次同步值，
 * 避免 zustand persist 异步 rehydrate 触发订阅、把恢复旧值误判为用户改动。
 */

import { resolveReaderBackgroundUrl } from "@/services/reader-background-service";
import { syncGetUiConfig, syncPutUiConfig } from "@/services/sync-service";
import { type SelectedModel, useProviderStore } from "@/store/provider-store";
import { useThemeStore } from "@/store/theme-store";
import type { ReaderBackground } from "@/styles/reader-scenes";

const UPDATED_AT_KEY = "uiConfigUpdatedAt";
const LAST_VALUES_KEY = "uiConfigLastValues";

/** 云端 UI 配置结构（reader_background 不含 fileUrl） */
interface UiConfig {
  updated_at: number;
  reader_background: Omit<ReaderBackground, "fileUrl"> | null;
  utility_model: SelectedModel | null;
}

function getUpdatedAt(): number {
  const raw = localStorage.getItem(UPDATED_AT_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isNaN(n) ? 0 : n;
}

function setUpdatedAt(ts: number) {
  localStorage.setItem(UPDATED_AT_KEY, String(ts));
}

function getLastValues(): string {
  return localStorage.getItem(LAST_VALUES_KEY) ?? "";
}

function setLastValues(serialized: string) {
  localStorage.setItem(LAST_VALUES_KEY, serialized);
}

/**
 * 从两个 store 取当前配置值并稳定序列化（剔除设备相关的 fileUrl）。
 * 同一函数生成保证序列化键序一致，可安全做字符串对比。
 */
function buildConfigValues(): string {
  const { readerBackground } = useThemeStore.getState();
  const { utilityModel } = useProviderStore.getState();

  let bg: UiConfig["reader_background"] = null;
  if (readerBackground) {
    const { fileUrl: _fileUrl, ...rest } = readerBackground;
    bg = rest;
  }

  return JSON.stringify({ reader_background: bg, utility_model: utilityModel });
}

/** 当前配置值是否与上次同步不同（即是否有真实的本地改动） */
function hasLocalChanges(): boolean {
  return buildConfigValues() !== getLastValues();
}

/** 把远端配置应用到本地 store（custom 背景按 fileName 重新解析 fileUrl） */
async function applyRemoteUiConfig(remote: UiConfig): Promise<void> {
  if (remote.reader_background) {
    const bg: ReaderBackground = { ...remote.reader_background };
    if (bg.kind === "custom" && bg.fileName) {
      try {
        bg.fileUrl = await resolveReaderBackgroundUrl(bg.fileName);
      } catch {
        // 文件可能尚未下载，保留配置，待资产下载后下轮再解析
      }
    }
    useThemeStore.getState().setReaderBackground(bg);
  }

  if (remote.utility_model !== undefined) {
    useProviderStore.getState().setUtilityModel(remote.utility_model);
  }

  setUpdatedAt(remote.updated_at ?? 0);
  // 以应用后的 store 实际值为准记录，避免随后被误判为本地改动而回推
  setLastValues(buildConfigValues());
}

/** 执行一轮 UI 配置同步（LWW） */
export async function syncUiConfigNow(): Promise<void> {
  try {
    const remoteRaw = await syncGetUiConfig();
    const localUpdatedAt = getUpdatedAt();

    let remote: UiConfig | null = null;
    if (remoteRaw != null) {
      try {
        remote = JSON.parse(remoteRaw) as UiConfig;
      } catch {
        remote = null; // 远端损坏则忽略
      }
    }

    // LWW：远端更新 -> 采纳远端（覆盖本地未推送的改动）
    if (remote && (remote.updated_at ?? 0) > localUpdatedAt) {
      await applyRemoteUiConfig(remote);
      return;
    }

    // 本地有真实改动则推送；远端不存在则推送建立基线
    if (hasLocalChanges() || remote == null) {
      const now = Date.now();
      const values = JSON.parse(buildConfigValues()) as Omit<UiConfig, "updated_at">;
      const config: UiConfig = { updated_at: now, ...values };
      await syncPutUiConfig(JSON.stringify(config));
      setUpdatedAt(now);
      setLastValues(buildConfigValues());
    }
  } catch (error) {
    console.warn("UI 配置同步失败（忽略）:", error);
  }
}

/**
 * 重新解析当前自定义背景的 fileUrl（背景文件刚下载下来后调用，
 * 让之前因文件缺失而未渲染的背景生效）。不视为本地改动（只补全本地 URL）。
 */
export async function reapplyCurrentBackground(): Promise<void> {
  const { readerBackground, setReaderBackground } = useThemeStore.getState();
  if (readerBackground?.kind !== "custom" || !readerBackground.fileName) return;
  try {
    const fileUrl = await resolveReaderBackgroundUrl(readerBackground.fileName);
    setReaderBackground({ ...readerBackground, fileUrl });
    // fileUrl 不参与值对比，此处无需更新 lastValues
  } catch {
    // 文件仍缺失，忽略
  }
}
