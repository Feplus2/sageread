use sqlx::{migrate::MigrateDatabase, Sqlite, SqlitePool};
use std::fs;
use tauri::{AppHandle, Manager};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize, Serialize, Debug)]
struct DefaultSkill {
    name: String,
    content: String,
    is_system: bool,
    is_active: bool,
}

pub async fn initialize(app_handle: &AppHandle) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let db_dir = app_data_dir.join("database");
    fs::create_dir_all(&db_dir)?;

    let db_path = db_dir.join("app.db");
    let db_url = format!(
        "sqlite:{}",
        db_path.to_str().ok_or("Invalid database path")?
    );

    let is_new_db = !Sqlite::database_exists(&db_url).await.unwrap_or(false);
    
    if is_new_db {
        Sqlite::create_database(&db_url).await?;
        println!("Database created at: {}", db_url);
    } else {
        println!("Database found at: {}", db_url);
    }

    let pool = SqlitePool::connect(&db_url).await?;

    sqlx::query(include_str!("./schema.sql"))
        .execute(&pool)
        .await?;
    println!("Database schema initialized.");

    run_migrations(&pool).await?;

    if is_new_db {
        initialize_default_skills(&pool).await?;
    }

    Ok(pool)
}

/// fork 专属迁移通道：上游同步 schema.sql 时的增量变更都放这里，避免改 schema.sql 冲突。
/// 所有迁移必须幂等。
async fn run_migrations(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    // threads.starred（对话星标）：已存在时忽略 duplicate column 错误
    let result = sqlx::query("ALTER TABLE threads ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: threads.starred added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    Ok(())
}

async fn initialize_default_skills(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    let default_skills_json = include_str!("./default-skills.json");
    let default_skills: Vec<DefaultSkill> = serde_json::from_str(default_skills_json)?;

    println!("Initializing {} default skills...", default_skills.len());

    for skill in default_skills {
        let skill_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            r#"
            INSERT INTO skills (id, name, content, is_active, is_system, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&skill_id)
        .bind(&skill.name)
        .bind(&skill.content)
        .bind(if skill.is_active { 1 } else { 0 })
        .bind(if skill.is_system { 1 } else { 0 })
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        println!("✅ Default skill initialized: {}", skill.name);
    }

    println!("Default skills initialization completed.");
    Ok(())
}
