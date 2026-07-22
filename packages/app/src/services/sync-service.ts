import { invoke } from "@tauri-apps/api/core";

export interface WebdavConfig {
  endpoint: string;
  username: string;
  password: string;
  remote_dir: string;
  /** off / hourly / daily */
  auto_backup: string;
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
