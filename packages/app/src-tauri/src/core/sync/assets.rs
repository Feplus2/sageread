//! L2 资产通道：字体与自定义背景图的内容寻址同步
//! 云端布局：sageread-sync/assets/<sha256前2位>/<sha256> + assets-index.json
//! 索引 key = "{kind}/{filename}"，kind ∈ {font, background}

use super::files::compute_sha256;
use super::models::WebdavConfig;
use super::webdav;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// L2 云端根目录（与 engine.rs 保持一致）
const L2_ROOT: &str = "sageread-sync";

/// 背景图支持的扩展名（与前端 reader-background-service 保持一致）
const BACKGROUND_EXTS: [&str; 4] = [".png", ".jpg", ".jpeg", ".webp"];

/* ---------------- 数据结构 ---------------- */

/// assets-index.json 中每个资产的条目
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetEntry {
    pub sha256: String,
    pub size: u64,
    /// "font" | "background"
    pub kind: String,
    pub filename: String,
    pub uploaded_by: String,
    pub uploaded_at: i64,
}

/// 本地扫描到的资产
struct LocalAsset {
    /// 索引 key："{kind}/{filename}"
    key: String,
    kind: String,
    filename: String,
    abs_path: PathBuf,
}

/// 资产同步统计（设置页展示）
#[derive(Serialize, Debug, Default)]
pub struct AssetsStatus {
    pub cloud_fonts: usize,
    pub cloud_backgrounds: usize,
    pub local_fonts: usize,
    pub local_backgrounds: usize,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 资产 blob 的云端路径：sageread-sync/assets/<sha256前2位>/<sha256>
fn asset_blob_path(sha256: &str) -> String {
    let prefix = &sha256[..2];
    format!("{L2_ROOT}/assets/{prefix}/{sha256}")
}

/// 资产在本地的存放目录：字体在 app_data_dir/fonts，背景在 config_dir/reader-backgrounds
fn asset_local_dir(kind: &str, app_data_dir: &Path, config_dir: &Path) -> PathBuf {
    if kind == "font" {
        app_data_dir.join("fonts")
    } else {
        config_dir.join("reader-backgrounds")
    }
}

/* ---------------- assets-index.json 读写 ---------------- */

/// 拉取云端 assets-index.json（不存在返回空 map）
pub async fn read_assets_index(config: &WebdavConfig) -> Result<HashMap<String, AssetEntry>, String> {
    let path = format!("{L2_ROOT}/assets-index.json");
    match webdav::get_path(config, &path).await? {
        Some(bytes) => {
            let index: HashMap<String, AssetEntry> =
                serde_json::from_slice(&bytes).map_err(|e| format!("解析 assets-index.json 失败: {e}"))?;
            Ok(index)
        }
        None => Ok(HashMap::new()),
    }
}

async fn write_assets_index(config: &WebdavConfig, index: &HashMap<String, AssetEntry>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| format!("序列化 assets-index.json 失败: {e}"))?;
    let path = format!("{L2_ROOT}/assets-index.json");
    webdav::put_path(config, &path, bytes).await
}

/// 读-合并-写 assets-index.json（竞态重试一次）
async fn merge_assets_index(config: &WebdavConfig, key: &str, entry: AssetEntry) -> Result<(), String> {
    for attempt in 0..2 {
        let mut index = read_assets_index(config).await?;
        index.insert(key.to_string(), entry.clone());
        match write_assets_index(config, &index).await {
            Ok(()) => return Ok(()),
            Err(e) if attempt == 0 => {
                log::warn!("assets-index 写入冲突，重试: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/* ---------------- 本地扫描 ---------------- */

/// 扫描某一目录中匹配扩展名的文件，构造 LocalAsset 清单
fn scan_dir(dir: &Path, kind: &str, exts: &[&str]) -> Vec<LocalAsset> {
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return result;
    };
    for entry in entries.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        let lower = filename.to_lowercase();
        if !exts.iter().any(|ext| lower.ends_with(ext)) {
            continue;
        }
        result.push(LocalAsset {
            key: format!("{kind}/{filename}"),
            kind: kind.to_string(),
            filename,
            abs_path: entry.path(),
        });
    }
    result
}

/// 扫描本地字体与背景图资产
fn scan_local_assets(app_data_dir: &Path, config_dir: &Path) -> Vec<LocalAsset> {
    let mut assets = Vec::new();
    assets.extend(scan_dir(&app_data_dir.join("fonts"), "font", &[".woff2"]));
    assets.extend(scan_dir(&config_dir.join("reader-backgrounds"), "background", &BACKGROUND_EXTS));
    assets
}

/* ---------------- 上传 ---------------- */

/// 上传本地有、云端索引无的资产（幂等去重，静默由调用方保证）
pub async fn upload_missing_assets(
    config: &WebdavConfig,
    app_data_dir: &Path,
    config_dir: &Path,
    device_id: &str,
) -> Result<usize, String> {
    let index = read_assets_index(config).await?;
    let local_assets = scan_local_assets(app_data_dir, config_dir);
    let mut uploaded = 0usize;

    for asset in &local_assets {
        if index.contains_key(&asset.key) {
            continue;
        }

        let sha256 = tokio::task::spawn_blocking({
            let path = asset.abs_path.clone();
            move || compute_sha256(&path)
        })
        .await
        .map_err(|e| format!("sha256 计算任务失败: {e}"))??;

        let size = std::fs::metadata(&asset.abs_path)
            .map_err(|e| format!("获取文件大小失败: {e}"))?
            .len();

        // 内容寻址去重：blob 已存在则跳过传输
        let blob_path = asset_blob_path(&sha256);
        if webdav::get_path(config, &blob_path).await?.is_none() {
            let prefix = &sha256[..2];
            webdav::ensure_remote_dirs(
                config,
                &[format!("{L2_ROOT}/assets"), format!("{L2_ROOT}/assets/{prefix}")],
            )
            .await?;

            let bytes = tokio::task::spawn_blocking({
                let path = asset.abs_path.clone();
                move || std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))
            })
            .await
            .map_err(|e| format!("文件读取任务失败: {e}"))??;

            webdav::put_path(config, &blob_path, bytes).await?;
        }

        let entry = AssetEntry {
            sha256,
            size,
            kind: asset.kind.clone(),
            filename: asset.filename.clone(),
            uploaded_by: device_id.to_string(),
            uploaded_at: now_ms(),
        };
        merge_assets_index(config, &asset.key, entry).await?;
        uploaded += 1;
        log::info!("资产已上传: {} ({size} bytes)", asset.key);
    }

    Ok(uploaded)
}

/* ---------------- 下载 ---------------- */

/// 下载云端索引有、本地无的资产，返回 (字体下载数, 背景下载数)
pub async fn download_missing_assets(
    config: &WebdavConfig,
    app_data_dir: &Path,
    config_dir: &Path,
) -> Result<(usize, usize), String> {
    let index = read_assets_index(config).await?;
    let mut fonts = 0usize;
    let mut backgrounds = 0usize;

    for (key, entry) in &index {
        let dir = asset_local_dir(&entry.kind, app_data_dir, config_dir);
        let local_path = dir.join(&entry.filename);
        if local_path.exists() {
            continue;
        }

        let blob_path = asset_blob_path(&entry.sha256);
        let Some(bytes) = webdav::get_path(config, &blob_path).await? else {
            log::warn!("资产 blob 缺失（跳过）: {key} -> {}", entry.sha256);
            continue;
        };

        // 校验 sha256
        let actual = {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("{:x}", hasher.finalize())
        };
        if actual != entry.sha256 {
            log::warn!("资产 sha256 校验失败（跳过）: {key}");
            continue;
        }

        std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
        std::fs::write(&local_path, &bytes).map_err(|e| format!("写入资产失败: {e}"))?;

        if entry.kind == "font" {
            fonts += 1;
        } else {
            backgrounds += 1;
        }
        log::info!("资产已下载: {key} ({} bytes)", bytes.len());
    }

    Ok((fonts, backgrounds))
}

/* ---------------- 状态统计 ---------------- */

/// 统计云端与本地的字体/背景数量（设置页展示）
pub async fn get_assets_status(
    config: &WebdavConfig,
    app_data_dir: &Path,
    config_dir: &Path,
) -> Result<AssetsStatus, String> {
    let index = read_assets_index(config).await?;
    let local = scan_local_assets(app_data_dir, config_dir);

    let mut status = AssetsStatus::default();
    for entry in index.values() {
        if entry.kind == "font" {
            status.cloud_fonts += 1;
        } else {
            status.cloud_backgrounds += 1;
        }
    }
    for asset in &local {
        if asset.kind == "font" {
            status.local_fonts += 1;
        } else {
            status.local_backgrounds += 1;
        }
    }
    Ok(status)
}
