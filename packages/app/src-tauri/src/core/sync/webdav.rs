use super::models::{BackupInfo, WebdavConfig};
use reqwest::{Client, Method, Url};

/// 拼接远端 URL：endpoint + remote_dir 相对路径（path 不含 remote_dir 前缀时由调用方带上）
fn remote_url(config: &WebdavConfig, path: &str) -> Result<Url, String> {
    let base = config.endpoint.trim_end_matches('/');
    let mut url = Url::parse(base).map_err(|e| format!("无效的 WebDAV 地址: {e}"))?;
    if !path.is_empty() {
        url.path_segments_mut()
            .map_err(|_| "WebDAV 地址无法作为路径基底".to_string())?
            .extend(path.split('/').filter(|s| !s.is_empty()));
    }
    Ok(url)
}

/// 远端文件路径（remote_dir/name）
fn file_path(config: &WebdavConfig, name: &str) -> String {
    format!("{}/{}", config.remote_dir.trim_matches('/'), name)
}

async fn send(
    config: &WebdavConfig,
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response, String> {
    let url = remote_url(config, path)?;
    let client = Client::new();
    let mut builder = client
        .request(method, url)
        .basic_auth(&config.username, Some(&config.password));
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder.send().await.map_err(|e| format!("网络请求失败: {e}"))
}

/// 逐级 MKCOL 创建远端目录；201=已创建、405=已存在，均视为成功
pub async fn ensure_dir(config: &WebdavConfig) -> Result<(), String> {
    let mut current = String::new();
    for segment in config.remote_dir.split('/').filter(|s| !s.is_empty()) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);
        let resp = send(config, Method::from_bytes(b"MKCOL").unwrap(), &current, None).await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) && status != 405 {
            return Err(format!("创建远端目录失败 (HTTP {status})"));
        }
    }
    Ok(())
}

pub async fn test_connection(config: &WebdavConfig) -> Result<String, String> {
    ensure_dir(config).await?;
    Ok("连接成功".to_string())
}

/// 按需确保多个远端目录存在（逐级 MKCOL，201/405 均视为成功）
pub async fn ensure_remote_dirs(config: &WebdavConfig, dirs: &[String]) -> Result<(), String> {
    for dir in dirs {
        let resp = send(config, Method::from_bytes(b"MKCOL").unwrap(), dir, None).await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) && status != 405 {
            return Err(format!("创建同步目录失败 (HTTP {status}): {dir}"));
        }
    }
    Ok(())
}

pub async fn put_file(config: &WebdavConfig, name: &str, bytes: Vec<u8>) -> Result<(), String> {
    let path = file_path(config, name);
    let resp = send(config, Method::PUT, &path, Some(bytes)).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("上传失败 (HTTP {status})"));
    }
    Ok(())
}

/// 读取远端文件；404 返回 None
pub async fn get_file(config: &WebdavConfig, name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = file_path(config, name);
    let resp = send(config, Method::GET, &path, None).await?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("下载失败 (HTTP {status})"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(Some(bytes.to_vec()))
}

pub async fn get_file_required(config: &WebdavConfig, name: &str) -> Result<Vec<u8>, String> {
    get_file(config, name)
        .await?
        .ok_or_else(|| "备份文件不存在".to_string())
}

pub async fn delete_file(config: &WebdavConfig, name: &str) -> Result<(), String> {
    let path = file_path(config, name);
    let resp = send(config, Method::DELETE, &path, None).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) && status != 404 {
        return Err(format!("删除远端文件失败 (HTTP {status})"));
    }
    Ok(())
}

/// 远端备份清单（index.json），不存在时为空列表
pub async fn read_index(config: &WebdavConfig) -> Result<Vec<BackupInfo>, String> {
    match get_file(config, "index.json").await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("解析 index.json 失败: {e}")),
        None => Ok(vec![]),
    }
}

pub async fn write_index(config: &WebdavConfig, entries: &[BackupInfo]) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(entries).map_err(|e| format!("序列化 index.json 失败: {e}"))?;
    put_file(config, "index.json", bytes).await
}

/* ---------------- L2 增量同步：绝对远端路径操作（不经 remote_dir 前缀） ---------------- */

pub async fn put_path(config: &WebdavConfig, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    let resp = send(config, Method::PUT, path, Some(bytes)).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("上传失败 (HTTP {status}): {path}"));
    }
    Ok(())
}

/// 读取远端绝对路径文件；404 返回 None
pub async fn get_path(config: &WebdavConfig, path: &str) -> Result<Option<Vec<u8>>, String> {
    let resp = send(config, Method::GET, path, None).await?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("下载失败 (HTTP {status}): {path}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(Some(bytes.to_vec()))
}

/// WebDAV MOVE（先写临时名再改名，避免半截文件被拉走）
pub async fn move_path(config: &WebdavConfig, from: &str, to: &str) -> Result<(), String> {
    let from_url = remote_url(config, from)?;
    let to_url = remote_url(config, to)?;
    let client = Client::new();
    let resp = client
        .request(Method::from_bytes(b"MOVE").unwrap(), from_url)
        .basic_auth(&config.username, Some(&config.password))
        .header("Destination", to_url.as_str())
        .header("Overwrite", "T")
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let status = resp.status().as_u16();
    // 201=已创建 204=已覆盖
    if !(200..300).contains(&status) {
        return Err(format!("改名失败 (HTTP {status}): {from} -> {to}"));
    }
    Ok(())
}

pub async fn delete_path(config: &WebdavConfig, path: &str) -> Result<(), String> {
    let resp = send(config, Method::DELETE, path, None).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) && status != 404 {
        return Err(format!("删除远端文件失败 (HTTP {status}): {path}"));
    }
    Ok(())
}
