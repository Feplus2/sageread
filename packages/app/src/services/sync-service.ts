import { invoke } from "@tauri-apps/api/core";

export interface WebdavConfig {
  endpoint: string;
  username: string;
  password: string;
  remote_dir: string;
  /** off / hourly / daily */
  auto_backup: string;
  /** L2 增量同步开关 */
  l2_enabled: boolean;
  /** off / 30s / 5min / 30min */
  sync_frequency: string;
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: number;
  device: string;
  app_version: string;
  db_sha256: string;
}

export interface BackupOutcome {
  status: "uploaded" | "skipped";
  message: string;
  backup_name: string | null;
}

export interface BackupManifest {
  format: string;
  version: number;
  created_at: number;
  device: string;
  app_version: string;
  contents: string[];
  db_sha256: string;
}

export interface SyncState {
  last_backup_at: number | null;
  last_backup_name: string | null;
  last_db_sha256: string | null;
  last_result: string | null;
}

export async function syncGetConfig(): Promise<WebdavConfig | null> {
  return invoke("sync_get_config");
}

export async function syncSaveConfig(config: WebdavConfig): Promise<void> {
  return invoke("sync_save_config", { config });
}

export async function syncTestConnection(config: WebdavConfig): Promise<string> {
  return invoke("sync_test_connection", { config });
}

export async function syncBackupNow(): Promise<BackupOutcome> {
  return invoke("sync_backup_now");
}

export async function syncListBackups(): Promise<BackupInfo[]> {
  return invoke("sync_list_backups");
}

export async function syncGetState(): Promise<SyncState> {
  return invoke("sync_get_state");
}

export async function syncRestore(backupName: string): Promise<BackupManifest> {
  return invoke("sync_restore", { backupName });
}

export async function syncRollback(): Promise<string> {
  return invoke("sync_rollback");
}

export async function syncRestartApp(): Promise<void> {
  return invoke("sync_restart_app");
}

/* ---------------- L2 增量同步 ---------------- */

export interface L2Status {
  enabled: boolean;
  frequency: string;
  device_id: string | null;
  last_pushed_seq: number;
  last_pulled: Record<string, number>;
  last_sync_at: number | null;
  last_result: string | null;
}

export interface SyncRunResult {
  status: string;
  message: string;
  pushed_rows: number;
  pulled_rows: number;
  /** 本轮拉取应用了变更的 book_status 书籍 id */
  book_status_ids: string[];
  /** 本轮拉取应用了变更的 threads 对话 id */
  thread_ids: string[];
  /** books 表有变更（书架需刷新） */
  books_changed: boolean;
  /** notes/book_notes 表有变更（划线/笔记需刷新） */
  notes_changed: boolean;
  /** 本轮下载的字体数 */
  fonts_downloaded: number;
  /** 本轮下载的背景图数 */
  backgrounds_downloaded: number;
}

export async function syncGetL2Status(): Promise<L2Status> {
  return invoke("sync_get_l2_status");
}

/** 立即执行一轮 L2 增量同步 */
export async function syncRunNow(): Promise<SyncRunResult> {
  return invoke("sync_run_now");
}

/** 只拉不推：打开书时的单点快拉（配合前端超时使用） */
export async function syncPullNow(): Promise<SyncRunResult> {
  return invoke("sync_pull_now");
}

/** 是否有未推送的本地变更（纯本地查询，无网络请求） */
export async function syncHasUnpushed(): Promise<boolean> {
  return invoke("sync_has_unpushed");
}

/* ---------------- L2 书籍文件通道 ---------------- */

export interface FileEntry {
  sha256: string;
  size: number;
  format: string;
  title: string;
  uploaded_by: string;
  uploaded_at: number;
}

export interface CloudBookInfo {
  book_id: string;
  title: string;
  format: string;
  size: number;
  sha256: string;
  local_exists: boolean;
}

export interface UploadAllResult {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  first_error: string | null;
}

/** 上传单本书的文件到云端 */
export async function syncUploadBook(bookId: string): Promise<FileEntry> {
  return invoke("sync_upload_book", { bookId });
}

/** 下载单本书的文件（懒加载） */
export async function syncDownloadBook(bookId: string): Promise<string> {
  return invoke("sync_download_book", { bookId });
}

/** 获取云端书目列表（含本地是否已有标记） */
export async function syncGetCloudBooks(): Promise<CloudBookInfo[]> {
  return invoke("sync_get_cloud_books");
}

/** 批量上传本地所有书籍文件（首次引导用） */
export async function syncUploadAllBooks(): Promise<UploadAllResult> {
  return invoke("sync_upload_all_books");
}

/* ---------------- L2 安全快照回滚 ---------------- */

export interface SnapshotInfo {
  name: string;
  created_at: number;
  size: number;
}

/** 列出 L2 同步前安全快照 */
export async function syncListL2Snapshots(): Promise<SnapshotInfo[]> {
  return invoke("sync_list_l2_snapshots");
}

/** 回滚到指定 L2 安全快照（重启生效） */
export async function syncRollbackL2(name: string): Promise<string> {
  return invoke("sync_rollback_l2", { name });
}

/* ---------------- L2 资产通道（字体/背景图） ---------------- */

export interface AssetsStatus {
  cloud_fonts: number;
  cloud_backgrounds: number;
  local_fonts: number;
  local_backgrounds: number;
}

/** 资产同步状态（云端/本地的字体与背景数量） */
export async function syncGetCloudAssets(): Promise<AssetsStatus> {
  return invoke("sync_get_cloud_assets");
}

/* ---------------- L2 UI 配置同步（背景选择/辅助模型） ---------------- */

/** 上传 UI 配置 JSON（不透明搬运） */
export async function syncPutUiConfig(json: string): Promise<void> {
  return invoke("sync_put_ui_config", { json });
}

/** 下载 UI 配置 JSON（不存在返回 null） */
export async function syncGetUiConfig(): Promise<string | null> {
  return invoke("sync_get_ui_config");
}
