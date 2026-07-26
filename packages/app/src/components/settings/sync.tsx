import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  type AssetsStatus,
  type BackupInfo,
  type CloudBookInfo,
  type L2Status,
  type SnapshotInfo,
  type SyncState,
  type WebdavConfig,
  syncBackupNow,
  syncGetCloudAssets,
  syncGetCloudBooks,
  syncGetConfig,
  syncGetL2Status,
  syncGetState,
  syncListBackups,
  syncListL2Snapshots,
  syncRestartApp,
  syncRestore,
  syncRollback,
  syncRollbackL2,
  syncRunNow,
  syncSaveConfig,
  syncTestConnection,
  syncUploadAllBooks,
} from "@/services/sync-service";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { CloudUpload, Database, RefreshCw, RotateCcw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const DEFAULT_CONFIG: WebdavConfig = {
  endpoint: "",
  username: "",
  password: "",
  remote_dir: "sageread-backups",
  auto_backup: "off",
  l2_enabled: false,
  sync_frequency: "30s",
};

const AUTO_BACKUP_OPTIONS = [
  { value: "off", label: "关闭" },
  { value: "hourly", label: "每小时一次" },
  { value: "daily", label: "每天一次" },
];

const L2_FREQUENCY_OPTIONS = [
  { value: "off", label: "关闭" },
  { value: "30s", label: "每 30 秒" },
  { value: "5min", label: "每 5 分钟" },
  { value: "30min", label: "每 30 分钟" },
];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function SyncSettings() {
  const [config, setConfig] = useState<WebdavConfig>(DEFAULT_CONFIG);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [restoringName, setRestoringName] = useState<string | null>(null);
  const [l2Status, setL2Status] = useState<L2Status | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [cloudBooks, setCloudBooks] = useState<CloudBookInfo[]>([]);
  const [isUploadingAll, setIsUploadingAll] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [assetsStatus, setAssetsStatus] = useState<AssetsStatus | null>(null);

  const updateConfig = (patch: Partial<WebdavConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  };

  const refreshL2Status = useCallback(() => {
    syncGetL2Status()
      .then(setL2Status)
      .catch((error) => console.error("加载同步状态失败:", error));
  }, []);

  // 加载配置与上次备份状态
  useEffect(() => {
    syncGetConfig()
      .then((saved) => {
        if (saved) setConfig({ ...DEFAULT_CONFIG, ...saved });
      })
      .catch((error) => console.error("加载 WebDAV 配置失败:", error));
    syncGetState()
      .then(setSyncState)
      .catch((error) => console.error("加载备份状态失败:", error));
    refreshL2Status();
  }, [refreshL2Status]);

  const refreshBackups = useCallback(async () => {
    setIsLoadingBackups(true);
    try {
      const list = await syncListBackups();
      setBackups(list);
    } catch (error) {
      console.error("获取备份列表失败:", error);
      toast.error("获取备份列表失败", { description: String(error) });
    } finally {
      setIsLoadingBackups(false);
    }
  }, []);

  const handleSaveConfig = async () => {
    setIsSaving(true);
    try {
      await syncSaveConfig(config);
      toast.success("配置已保存");
    } catch (error) {
      console.error("保存配置失败:", error);
      toast.error("保存配置失败", { description: String(error) });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    try {
      const message = await syncTestConnection(config);
      toast.success(message);
    } catch (error) {
      console.error("测试连接失败:", error);
      toast.error("连接失败", { description: String(error) });
    } finally {
      setIsTesting(false);
    }
  };

  const handleBackupNow = async () => {
    setIsBackingUp(true);
    try {
      const outcome = await syncBackupNow();
      if (outcome.status === "skipped") {
        toast.info(outcome.message);
      } else {
        toast.success(outcome.message);
      }
      setSyncState(await syncGetState());
      refreshBackups();
    } catch (error) {
      console.error("备份失败:", error);
      toast.error("备份失败", { description: String(error) });
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestore = async (backup: BackupInfo) => {
    const confirmed = await ask(
      `确定要从 ${dayjs(backup.created_at).format("YYYY-MM-DD HH:mm:ss")} 的备份恢复吗？\n\n当前数据会先自动备份（可回滚），然后替换为备份内容并重启应用。`,
      { title: "确认恢复", kind: "warning" },
    );
    if (!confirmed) return;

    setRestoringName(backup.name);
    try {
      await syncRestore(backup.name);
      const restart = await ask("恢复已就绪。是否立即重启应用完成恢复？", { title: "恢复就绪" });
      if (restart) {
        await syncRestartApp();
      } else {
        toast.info("请稍后手动重启应用以完成恢复");
      }
    } catch (error) {
      console.error("恢复失败:", error);
      toast.error("恢复失败", { description: String(error) });
    } finally {
      setRestoringName(null);
    }
  };

  const handleRollback = async () => {
    const confirmed = await ask("回滚会撤销最近一次恢复，换回恢复前的数据。确定继续吗？", {
      title: "确认回滚",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      const message = await syncRollback();
      toast.success(message);
    } catch (error) {
      console.error("回滚失败:", error);
      toast.error("回滚失败", { description: String(error) });
    }
  };

  // 保存配置并联动 L2 状态展示
  const handleSaveL2Config = async (patch: Partial<WebdavConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    try {
      await syncSaveConfig(next);
      refreshL2Status();

      // 首次开启 L2 时引导上传书籍文件
      if (patch.l2_enabled === true && !config.l2_enabled) {
        try {
          const cloudList = await syncGetCloudBooks();
          if (cloudList.length === 0) {
            const confirmed = await ask(
              "检测到本地有书籍但云端还没有文件。\n\n是否立即上传所有书籍文件到云端？（元数据已自动同步，此步仅上传文件）",
              { title: "书籍文件同步", kind: "info" },
            );
            if (confirmed) {
              setIsUploadingAll(true);
              try {
                const result = await syncUploadAllBooks();
                toast.success("上传完成", {
                  description: `共 ${result.total} 本，新上传 ${result.uploaded}，跳过 ${result.skipped}`,
                });
                refreshCloudBooks();
              } finally {
                setIsUploadingAll(false);
              }
            }
          }
        } catch {
          // 引导失败不影响主流程
        }
      }
    } catch (error) {
      console.error("保存配置失败:", error);
      toast.error("保存配置失败", { description: String(error) });
    }
  };

  const handleRunSyncNow = async () => {
    setIsSyncing(true);
    try {
      const result = await syncRunNow();
      toast.success("同步完成", { description: result.message });
      refreshL2Status();
    } catch (error) {
      console.error("同步失败:", error);
      toast.error("同步失败", { description: String(error) });
    } finally {
      setIsSyncing(false);
    }
  };

  const refreshCloudBooks = useCallback(async (silent = true) => {
    try {
      const list = await syncGetCloudBooks();
      setCloudBooks(list);
      return list.length;
    } catch (error) {
      console.error("获取云端书目失败:", error);
      if (!silent) {
        toast.error("获取云端书目失败", { description: String(error) });
      }
      return -1;
    }
  }, []);

  const handleUploadAllBooks = async () => {
    setIsUploadingAll(true);
    try {
      const result = await syncUploadAllBooks();
      let detail = `共 ${result.total} 本，新上传 ${result.uploaded}，跳过 ${result.skipped}，失败 ${result.failed}`;
      if (result.failed > 0 && result.first_error) {
        detail += `\n首个失败：${result.first_error}`;
      }
      if (result.failed > 0) {
        toast.error("上传未全部完成", { description: detail });
      } else if (result.uploaded > 0) {
        toast.success("上传完成", { description: detail });
      } else {
        toast.info("上传完成", { description: detail });
      }

      // 坚果云 PUT 后 GET 可能有短暂延迟：延迟重试刷新，直到读到数据或超过 3 次
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 800));
        const count = await refreshCloudBooks(attempt < 2);
        if (count > 0) break;
      }
    } catch (error) {
      console.error("批量上传失败:", error);
      toast.error("批量上传失败", { description: String(error) });
    } finally {
      setIsUploadingAll(false);
    }
  };

  const refreshSnapshots = useCallback(async () => {
    setIsLoadingSnapshots(true);
    try {
      const list = await syncListL2Snapshots();
      setSnapshots(list);
    } catch (error) {
      console.error("获取快照列表失败:", error);
    } finally {
      setIsLoadingSnapshots(false);
    }
  }, []);

  const refreshAssetsStatus = useCallback(async () => {
    try {
      const status = await syncGetCloudAssets();
      setAssetsStatus(status);
    } catch (error) {
      console.error("获取资产状态失败:", error);
    }
  }, []);

  const handleRollbackL2 = async (snapshot: SnapshotInfo) => {
    const confirmed = await ask(
      `确定要回滚到 ${dayjs(snapshot.created_at).format("YYYY-MM-DD HH:mm:ss")} 的同步前快照吗？\n\n当前数据会先备份，然后替换为快照内容。`,
      { title: "确认回滚", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      const message = await syncRollbackL2(snapshot.name);
      toast.success(message);
      const restart = await ask("是否立即重启应用完成回滚？", { title: "回滚就绪" });
      if (restart) {
        await syncRestartApp();
      }
    } catch (error) {
      console.error("回滚失败:", error);
      toast.error("回滚失败", { description: String(error) });
    }
  };

  // L2 开启时加载云端书目、快照列表和资产状态
  useEffect(() => {
    if (config.l2_enabled) {
      refreshCloudBooks();
      refreshSnapshots();
      refreshAssetsStatus();
    }
  }, [config.l2_enabled, refreshCloudBooks, refreshSnapshots, refreshAssetsStatus]);

  return (
    <div className="space-y-4 p-4 pt-3">
      <div className="rounded-lg bg-muted/80 p-4">
        <h2 className="text mb-4 dark:text-neutral-200">WebDAV 配置</h2>
        <div className="space-y-3">
          <div>
            <span className="text-neutral-600 text-xs dark:text-neutral-400">服务器地址</span>
            <Input
              value={config.endpoint}
              onChange={(e) => updateConfig({ endpoint: e.target.value })}
              placeholder="https://dav.jianguoyun.com/dav/"
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-neutral-600 text-xs dark:text-neutral-400">账号</span>
              <Input
                value={config.username}
                onChange={(e) => updateConfig({ username: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <span className="text-neutral-600 text-xs dark:text-neutral-400">密码 / 应用密码</span>
              <Input
                type="password"
                value={config.password}
                onChange={(e) => updateConfig({ password: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-neutral-600 text-xs dark:text-neutral-400">远端目录</span>
              <Input
                value={config.remote_dir}
                onChange={(e) => updateConfig({ remote_dir: e.target.value })}
                placeholder="sageread-backups"
                className="mt-1"
              />
            </div>
            <div>
              <span className="text-neutral-600 text-xs dark:text-neutral-400">自动备份</span>
              <Select value={config.auto_backup} onValueChange={(value) => updateConfig({ auto_backup: value })}>
                <SelectTrigger className="mt-1 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTO_BACKUP_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={handleSaveConfig} disabled={isSaving}>
              {isSaving ? "保存中..." : "保存配置"}
            </Button>
            <Button size="sm" variant="outline" onClick={handleTestConnection} disabled={isTesting}>
              {isTesting ? "测试中..." : "测试连接"}
            </Button>
          </div>
          <p className="text-neutral-600 text-xs dark:text-neutral-400">
            配置仅保存在本机；坚果云请在账号设置里创建应用密码。备份不包含书籍文件和 API 密钥（设计如此）。
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-muted/80 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text dark:text-neutral-200">备份</h2>
          <Button size="sm" onClick={handleBackupNow} disabled={isBackingUp}>
            <CloudUpload className="h-4 w-4" />
            {isBackingUp ? "备份中..." : "立即备份"}
          </Button>
        </div>
        <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">
          {syncState?.last_backup_at
            ? `上次备份：${dayjs(syncState.last_backup_at).format("YYYY-MM-DD HH:mm:ss")}（${
                syncState.last_result === "uploaded" ? "已上传" : "已完成"
              }）`
            : "还没有备份过"}
        </p>
      </div>

      <div className="rounded-lg bg-muted/80 p-4">
        <div className="flex items-center justify-between pb-2">
          <h2 className="text dark:text-neutral-200">恢复</h2>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleRollback} title="撤销最近一次恢复">
              <RotateCcw className="h-4 w-4" />
              回滚
            </Button>
            <Button size="sm" variant="outline" onClick={refreshBackups} disabled={isLoadingBackups}>
              <RefreshCw className={`h-4 w-4 ${isLoadingBackups ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
        </div>

        {backups.length === 0 ? (
          <p className="text-neutral-600 text-xs dark:text-neutral-400">暂无远端备份，点刷新获取列表</p>
        ) : (
          <div className="space-y-2">
            {backups.map((backup) => (
              <div key={backup.name} className="flex items-center justify-between border-t pt-2">
                <div>
                  <div className="text-sm dark:text-neutral-200">
                    {dayjs(backup.created_at).format("YYYY-MM-DD HH:mm:ss")}
                  </div>
                  <div className="text-neutral-600 text-xs dark:text-neutral-400">
                    {backup.device} · v{backup.app_version} · {formatSize(backup.size)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restoringName !== null}
                  onClick={() => handleRestore(backup)}
                >
                  {restoringName === backup.name ? "恢复中..." : "恢复"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-lg bg-muted/80 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text dark:text-neutral-200">增量同步</h2>
          <Switch
            checked={config.l2_enabled}
            onCheckedChange={(checked) => handleSaveL2Config({ l2_enabled: checked === true })}
          />
        </div>
        <p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
          多设备经 WebDAV 双向同步书单、进度、笔记、对话等元数据（不含书籍文件与 API 密钥）；本地变更会在 25
          秒内自动同步，无变更时不产生网络请求
        </p>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-neutral-600 text-xs dark:text-neutral-400">
            拉取兜底频率（推送始终 25 秒内发出，不受此项影响）
          </span>
          <Select
            value={config.sync_frequency}
            onValueChange={(value) => handleSaveL2Config({ sync_frequency: value })}
            disabled={!config.l2_enabled}
          >
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {L2_FREQUENCY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div className="text-neutral-600 text-xs dark:text-neutral-400">
            {l2Status?.last_sync_at
              ? `最近同步：${dayjs(l2Status.last_sync_at).format("YYYY-MM-DD HH:mm:ss")} · ${l2Status.last_result ?? ""}`
              : "还没有同步过"}
            {l2Status?.device_id && <div className="mt-1">设备 ID：{l2Status.device_id.slice(0, 8)}…</div>}
          </div>
          <Button size="sm" variant="outline" onClick={handleRunSyncNow} disabled={isSyncing || !config.l2_enabled}>
            {isSyncing ? "同步中..." : "立即同步"}
          </Button>
        </div>
      </div>

      {/* 书籍文件同步 */}
      {config.l2_enabled && (
        <div className="rounded-lg bg-muted/80 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text dark:text-neutral-200">书籍文件同步</h2>
            <Button size="sm" variant="outline" onClick={handleUploadAllBooks} disabled={isUploadingAll}>
              <Upload className="h-4 w-4" />
              {isUploadingAll ? "上传中..." : "上传全部"}
            </Button>
          </div>
          <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">
            云端共 {cloudBooks.length} 本书籍文件，其中 {cloudBooks.filter((b) => b.local_exists).length} 本本地已有
          </p>
          {cloudBooks.filter((b) => !b.local_exists).length > 0 && (
            <p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
              {cloudBooks.filter((b) => !b.local_exists).length} 本仅在云端，打开时自动下载
            </p>
          )}
        </div>
      )}

      {/* 资产同步（字体/背景图/背景选择/辅助模型） */}
      {config.l2_enabled && (
        <div className="rounded-lg bg-muted/80 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text dark:text-neutral-200">资产与偏好同步</h2>
            <Button size="sm" variant="outline" onClick={refreshAssetsStatus}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
          </div>
          <p className="mt-2 text-neutral-600 text-xs dark:text-neutral-400">
            字体：云端 {assetsStatus?.cloud_fonts ?? 0} 个（本地 {assetsStatus?.local_fonts ?? 0} 个）· 背景图：云端{" "}
            {assetsStatus?.cloud_backgrounds ?? 0} 张（本地 {assetsStatus?.local_backgrounds ?? 0} 张）
          </p>
          <p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
            字体、自定义背景图自动双向同步；当前背景选择与辅助模型选择随 L2
            同步。辅助模型需两端配置同一服务商才生效；API 密钥永不同步。
          </p>
        </div>
      )}

      {/* 同步前快照 */}
      {config.l2_enabled && (
        <div className="rounded-lg bg-muted/80 p-4">
          <div className="flex items-center justify-between pb-2">
            <h2 className="text dark:text-neutral-200">同步前快照</h2>
            <Button size="sm" variant="outline" onClick={refreshSnapshots} disabled={isLoadingSnapshots}>
              <RefreshCw className={`h-4 w-4 ${isLoadingSnapshots ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
          <p className="mb-2 text-neutral-600 text-xs dark:text-neutral-400">
            每次应用远端变更前自动创建，保留最近 3 份
          </p>
          {snapshots.length === 0 ? (
            <p className="text-neutral-600 text-xs dark:text-neutral-400">暂无快照</p>
          ) : (
            <div className="space-y-2">
              {snapshots.map((snapshot) => (
                <div key={snapshot.name} className="flex items-center justify-between border-t pt-2">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-neutral-500" />
                    <div>
                      <div className="text-sm dark:text-neutral-200">
                        {dayjs(snapshot.created_at).format("YYYY-MM-DD HH:mm:ss")}
                      </div>
                      <div className="text-neutral-600 text-xs dark:text-neutral-400">{formatSize(snapshot.size)}</div>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => handleRollbackL2(snapshot)}>
                    <RotateCcw className="h-3 w-3" />
                    回滚
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
