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
