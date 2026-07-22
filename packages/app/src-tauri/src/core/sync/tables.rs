/// 同步表注册表：主键与"已知列"清单（协议 §5 宽容读者原则的写入侧——只写已知列）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ColType {
    Text,
    Int,
}

pub struct SyncTable {
    pub name: &'static str,
    pub pk: &'static str,
    pub columns: &'static [(&'static str, ColType)],
}

pub const TABLES: &[SyncTable] = &[
    SyncTable {
        name: "threads",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("metadata", ColType::Text),
            ("title", ColType::Text),
            ("messages", ColType::Text),
            ("starred", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "books",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("title", ColType::Text),
            ("author", ColType::Text),
            ("format", ColType::Text),
            ("file_path", ColType::Text),
            ("cover_path", ColType::Text),
            ("file_size", ColType::Int),
            ("language", ColType::Text),
            ("tags", ColType::Text),
            ("trashed_at", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "book_status",
        pk: "book_id",
        columns: &[
            ("book_id", ColType::Text),
            ("status", ColType::Text),
            ("progress_current", ColType::Int),
            ("progress_total", ColType::Int),
            ("location", ColType::Text),
            ("last_read_at", ColType::Int),
            ("position_changed_at", ColType::Int),
            ("dwell_seconds", ColType::Int),
            ("started_at", ColType::Int),
            ("completed_at", ColType::Int),
            ("metadata", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "reading_sessions",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("started_at", ColType::Int),
            ("ended_at", ColType::Int),
            ("duration_seconds", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "tags",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("name", ColType::Text),
            ("color", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "notes",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("book_meta", ColType::Text),
            ("title", ColType::Text),
            ("content", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "book_notes",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("type", ColType::Text),
            ("cfi", ColType::Text),
            ("text", ColType::Text),
            ("style", ColType::Text),
            ("color", ColType::Text),
            ("note", ColType::Text),
            ("context_before", ColType::Text),
            ("context_after", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "skills",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("name", ColType::Text),
            ("content", ColType::Text),
            ("is_active", ColType::Int),
            ("is_system", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
];

pub fn find_table(name: &str) -> Option<&'static SyncTable> {
    TABLES.iter().find(|t| t.name == name)
}
