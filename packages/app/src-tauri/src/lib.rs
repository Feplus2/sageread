// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod core;
use crate::core::{
    books::commands::{
        create_book_note,
        create_reading_session,
        delete_book,
        delete_book_note,
        get_active_reading_session,
        get_all_reading_sessions,
        get_book_by_id,
        get_book_notes,
        get_book_status,
        get_book_with_status_by_id,
        get_books,
        get_books_with_status,
        get_reading_session,
        get_reading_sessions_by_book,
        get_trashed_books,
        purge_book,
        restore_book,
        save_book,
        update_book,
        update_book_note,
        update_book_status,
        update_reading_session,
    },
    database,
    converter::{cancel_convert, convert_pdf_to_epub, ConverterState},
    fonts::commands::{upload_and_convert_font, upload_font_data},
    llama::commands::{
        delete_local_model, download_llama_server, download_model_file,
        ensure_llamacpp_directories, get_app_data_dir, get_llamacpp_backend_path, greet,
        list_local_models, llama_server_binary_name_cmd,
    },
    notes::commands::{create_note, delete_note, get_note_by_id, get_notes, update_note},
    skills::commands::{
        create_skill, delete_skill, get_skill_by_id, get_skills, toggle_skill_active,
        update_skill,
    },
    state::AppState,
    sync::commands::{
        sync_backup_now, sync_download_book, sync_get_cloud_assets, sync_get_cloud_books,
        sync_get_config, sync_get_l2_status, sync_get_state, sync_get_ui_config,
        sync_has_unpushed, sync_list_backups, sync_list_l2_snapshots, sync_pull_now,
        sync_put_ui_config, sync_restore, sync_restart_app, sync_rollback, sync_rollback_l2,
        sync_run_now, sync_save_config, sync_test_connection, sync_upload_all_books,
        sync_upload_book,
    },
    tags::commands::{
        create_tag, delete_tag, get_tag_by_id, get_tag_by_name, get_tags, update_tag,
    },
    threads::commands::{
        create_thread, delete_thread, edit_thread, get_all_threads, get_latest_thread_by_book_id,
        get_thread_by_id, get_threads_by_book_id,
    },
    web_search::web_search,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::default())
        .manage(ConverterState::default())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_llamacpp::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_epub::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            if std::env::consts::OS == "windows" {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_decorations(false) {
                        eprintln!("Failed to set window decorations: {}", e);
                    }
                }
            }
            
            // Check for updates on startup
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    match handle.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                                    log::error!("Failed to install update: {}", e);
                                }
                            }
                            Ok(None) => {
                                log::info!("No update available");
                            }
                            Err(e) => {
                                log::error!("Failed to check for updates: {}", e);
                            }
                        },
                        Err(e) => {
                            log::error!("Failed to get updater: {}", e);
                        }
                    }
                });
            }
            
            tauri::async_runtime::spawn(async move {
                // 启动时先应用待恢复数据（在数据库初始化之前）
                if let Err(e) = core::sync::restore::apply_pending_restore(&app_handle) {
                    log::error!("应用待恢复数据失败: {}", e);
                }

                let pool = database::initialize(&app_handle)
                    .await
                    .expect("Failed to initialize database");

                let state = app_handle.state::<AppState>();
                let mut db_pool_guard = state.db_pool.lock().await;
                *db_pool_guard = Some(pool);

                // 启动时清理回收站：超过保留期的书籍彻底删除
                drop(db_pool_guard);
                if let Err(e) = core::books::commands::purge_expired_trash(&app_handle).await {
                    log::error!("回收站自动清理失败: {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_thread,
            edit_thread,
            delete_thread,
            get_latest_thread_by_book_id,
            get_threads_by_book_id,
            get_thread_by_id,
            get_all_threads,
            save_book,
            get_books,
            get_book_by_id,
            update_book,
            delete_book,
            restore_book,
            get_trashed_books,
            purge_book,
            get_book_status,
            update_book_status,
            get_books_with_status,
            get_book_with_status_by_id,
            // reading sessions
            create_reading_session,
            get_reading_session,
            update_reading_session,
            get_reading_sessions_by_book,
            get_active_reading_session,
            get_all_reading_sessions,
            // book notes
            create_book_note,
            get_book_notes,
            update_book_note,
            delete_book_note,
            create_tag,
            get_tags,
            get_tag_by_id,
            get_tag_by_name,
            update_tag,
            delete_tag,
            // notes
            create_note,
            update_note,
            delete_note,
            get_note_by_id,
            get_notes,
            // skills
            create_skill,
            get_skills,
            get_skill_by_id,
            update_skill,
            delete_skill,
            toggle_skill_active,
            // fonts
            upload_and_convert_font,
            upload_font_data,
            // llama
            greet,
            get_app_data_dir,
            get_llamacpp_backend_path,
            ensure_llamacpp_directories,
            download_llama_server,
            llama_server_binary_name_cmd,
            list_local_models,
            download_model_file,
            delete_local_model,
            // sync (WebDAV 备份/恢复)
            sync_get_config,
            sync_save_config,
            sync_test_connection,
            sync_backup_now,
            sync_list_backups,
            sync_get_state,
            sync_restore,
            sync_rollback,
            sync_restart_app,
            sync_get_l2_status,
            sync_run_now,
            sync_pull_now,
            sync_has_unpushed,
            sync_upload_book,
            sync_download_book,
            sync_get_cloud_books,
            sync_upload_all_books,
            sync_list_l2_snapshots,
            sync_rollback_l2,
            sync_get_cloud_assets,
            sync_put_ui_config,
            sync_get_ui_config,
            web_search,
            // converter (PDF → EPUB)
            convert_pdf_to_epub,
            cancel_convert,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 阻止默认关闭：先完成退出前推送与进程清理，再主动销毁窗口
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let app_handle = window.app_handle().clone();

                    // 退出前推送：L2 开启且有未推送变更时同步一轮（5s 超时，失败不阻塞退出）
                    let exit_sync = async {
                        let config = crate::core::sync::commands::load_webdav_config(&app_handle)?;
                        if !config.l2_enabled || config.endpoint.is_empty() {
                            return Ok::<(), String>(());
                        }
                        let state = app_handle.state::<AppState>();
                        let pool_guard = state.db_pool.lock().await;
                        let Some(pool) = pool_guard.as_ref() else {
                            return Ok(());
                        };
                        let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
                        let sync_state = crate::core::sync::backup::read_sync_state(&config_dir);
                        if crate::core::sync::engine::has_unpushed(pool, sync_state.last_pushed_seq.unwrap_or(0))
                            .await?
                        {
                            log::info!("退出前推送未同步变更...");
                            crate::core::sync::engine::run_sync(&app_handle, pool, &config).await?;
                        }
                        Ok(())
                    };
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), exit_sync).await;

                    if let Err(e) = tauri_plugin_llamacpp::cleanup_llama_processes(app_handle).await
                    {
                        log::error!("清理 llamacpp 进程失败: {}", e);
                    }

                    // destroy 不再触发 CloseRequested，避免循环
                    let _ = window.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
