//! PDF → EPUB 转换：调用 Books_Converter sidecar（hybrid 引擎），流式回传进度。
//!
//! sidecar 以 headless 模式运行，向 stdout 逐行打印 JSON 进度；本模块逐行解析并
//! 通过 `convert://progress` 事件转发给前端。LLM 配置复用辅助模型（OpenAI 兼容端点），
//! MinerU Token 由前端设置项传入。

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// 保存当前正在运行的转换子进程，供取消使用
pub struct ConverterState {
    pub child: tokio::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

impl Default for ConverterState {
    fn default() -> Self {
        Self {
            child: tokio::sync::Mutex::new(None),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertParams {
    pub pdf_path: String,
    pub ocr: bool,
    /// 目标语言（None=不翻译，Some("zh"/"en"/"ja"/...)）
    pub translate: Option<String>,
    pub mineru_token: String,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
}

/// 启动 PDF→EPUB 转换（异步，进度经 `convert://progress` 事件回传）
#[tauri::command]
pub async fn convert_pdf_to_epub(app: AppHandle, params: ConvertParams) -> Result<(), String> {
    // 输出目录：应用数据目录下的 converter/
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;
    let output_dir = app_data_dir.join("converter");
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("创建转换输出目录失败: {}", e))?;

    // 组装 CLI 参数
    let mut args: Vec<String> = vec![
        params.pdf_path.clone(),
        "--headless".to_string(),
        "--output-dir".to_string(),
        output_dir.to_string_lossy().to_string(),
    ];
    if !params.ocr {
        args.push("--no-ocr".to_string());
    }
    if let Some(lang) = &params.translate {
        if !lang.is_empty() {
            args.push("--translate".to_string());
            args.push(lang.clone());
        }
    }

    log::info!("[Converter] 启动转换: {}", params.pdf_path);

    let command = app
        .shell()
        .sidecar("books_converter")
        .map_err(|e| format!("无法创建转换命令: {}", e))?
        .args(args)
        .env("MINERU_TOKEN", &params.mineru_token)
        .env("DEEPSEEK_BASE_URL", &params.llm_base_url)
        .env("DEEPSEEK_API_KEY", &params.llm_api_key)
        .env("DEEPSEEK_MODEL", &params.llm_model);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("启动转换进程失败: {}", e))?;

    // 保存子进程句柄以便取消
    {
        let state = app.state::<ConverterState>();
        *state.child.lock().await = Some(child);
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    // 按行切分，逐行转发 JSON 进度
                    while let Some(pos) = buffer.find('\n') {
                        let line: String = buffer.drain(..=pos).collect();
                        let line = line.trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        let _ = app_handle.emit("convert://progress", line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let msg = String::from_utf8_lossy(&bytes);
                    for l in msg.lines() {
                        let l = l.trim();
                        if !l.is_empty() {
                            log::info!("[Converter] {}", l);
                        }
                    }
                }
                CommandEvent::Terminated(status) => {
                    let success = status.code == Some(0);
                    log::info!("[Converter] 进程退出, code={:?}", status.code);
                    let _ = app_handle.emit(
                        "convert://progress",
                        format!(r#"{{"type":"terminated","success":{}}}"#, success),
                    );
                    break;
                }
                CommandEvent::Error(e) => {
                    log::error!("[Converter] 进程错误: {}", e);
                    let payload = serde_json::json!({"type":"error","message":e}).to_string();
                    let _ = app_handle.emit("convert://progress", payload);
                    break;
                }
                _ => {}
            }
        }
        // 清理子进程句柄
        let state = app_handle.state::<ConverterState>();
        *state.child.lock().await = None;
    });

    Ok(())
}

/// 取消正在进行的转换
#[tauri::command]
pub async fn cancel_convert(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ConverterState>();
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| format!("终止转换失败: {}", e))?;
        log::info!("[Converter] 已取消转换");
    }
    Ok(())
}
