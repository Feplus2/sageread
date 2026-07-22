use serde_json::Value;

/// threads 整行数据（消息字段是 JSON 字符串）
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadRowData {
    pub id: String,
    pub book_id: Option<String>,
    pub metadata: String,
    pub title: String,
    pub messages: String,
    pub starred: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 通用 LWW 判断：remote 是否赢（本地不存在必赢，严格大于才赢——保证重放幂等）
pub fn remote_wins(local_updated_at: Option<i64>, remote_updated_at: i64) -> bool {
    match local_updated_at {
        None => true,
        Some(local) => remote_updated_at > local,
    }
}

fn parse_messages(json: &str) -> Vec<Value> {
    serde_json::from_str(json).unwrap_or_default()
}

/// 消息时间（排序键）：metadata.createdAt 优先，其次 updatedAt
fn message_time(msg: &Value) -> i64 {
    msg.pointer("/metadata/createdAt")
        .and_then(Value::as_i64)
        .or_else(|| msg.pointer("/metadata/updatedAt").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// 同 id 冲突时的新旧判断键：metadata.updatedAt 优先，其次 createdAt
fn message_updated_at(msg: &Value) -> i64 {
    msg.pointer("/metadata/updatedAt")
        .and_then(Value::as_i64)
        .or_else(|| msg.pointer("/metadata/createdAt").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// 消息级并集合并（协议 §6）：
/// 两边 messages 按消息 id 取并集，按消息时间稳定排序；
/// 同 id 消息按 metadata.updated_at 取新（相等时保本地，确定性）。
pub fn merge_thread_messages(local_json: &str, remote_json: &str) -> Vec<Value> {
    let local = parse_messages(local_json);
    let remote = parse_messages(remote_json);

    // id -> 消息；无 id 消息按唯一处理（给合成 id）
    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut insert_order: Vec<String> = Vec::new();
    let mut noid_counter = 0usize;

    for (is_remote, msg) in local.into_iter().map(|m| (false, m)).chain(remote.into_iter().map(|m| (true, m))) {
        let id = match msg.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => {
                noid_counter += 1;
                format!("__noid_{}_{}", is_remote, noid_counter)
            }
        };

        match by_id.get(&id) {
            None => {
                insert_order.push(id.clone());
                by_id.insert(id, msg);
            }
            Some(existing) => {
                if message_updated_at(&msg) > message_updated_at(existing) {
                    by_id.insert(id, msg);
                }
            }
        }
    }

    // 稳定排序：消息时间升序，同时间保持插入顺序
    let mut merged: Vec<Value> = insert_order.into_iter().map(|id| by_id.remove(&id).unwrap()).collect();
    merged.sort_by_key(message_time);
    merged
}

/// threads 行级合并：messages 永远并集合并，其余字段整行 LWW
pub fn merge_thread_row(local: Option<&ThreadRowData>, remote: &ThreadRowData) -> ThreadRowData {
    match local {
        None => remote.clone(),
        Some(local) => {
            let merged_messages = merge_thread_messages(&local.messages, &remote.messages);
            let messages = serde_json::to_string(&merged_messages).unwrap_or_else(|_| "[]".to_string());
            if remote_wins(Some(local.updated_at), remote.updated_at) {
                ThreadRowData {
                    messages,
                    ..remote.clone()
                }
            } else {
                ThreadRowData {
                    messages,
                    ..local.clone()
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, created_at: i64, updated_at: i64) -> Value {
        serde_json::json!({
            "id": id,
            "role": "user",
            "parts": [],
            "metadata": { "createdAt": created_at, "updatedAt": updated_at }
        })
    }

    fn msgs_json(msgs: &[Value]) -> String {
        serde_json::to_string(&serde_json::json!(msgs)).unwrap()
    }

    fn ids(msgs: &[Value]) -> Vec<String> {
        msgs.iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn test_merge_union_and_sort() {
        // 并集：两边不同 id 的消息都保留，按时间排序
        let local = msgs_json(&[msg("a", 100, 100), msg("c", 300, 300)]);
        let remote = msgs_json(&[msg("b", 200, 200), msg("d", 400, 400)]);
        let merged = merge_thread_messages(&local, &remote);
        assert_eq!(ids(&merged), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn test_merge_interleaved_sort() {
        // 分叉场景：本地先有 a,c；远端后有 b（时间更晚）→ 并集后按时间 b 在最后
        let local = msgs_json(&[msg("a", 100, 100), msg("c", 200, 200)]);
        let remote = msgs_json(&[msg("a", 100, 100), msg("b", 300, 300)]);
        let merged = merge_thread_messages(&local, &remote);
        assert_eq!(ids(&merged), vec!["a", "c", "b"]);
    }

    #[test]
    fn test_merge_same_id_newer_wins() {
        // 同 id：remote 更新（updatedAt 更大）则取 remote 内容
        let mut older = msg("a", 100, 100);
        older["parts"] = serde_json::json!([{"type": "text", "text": "旧"}]);
        let mut newer = msg("a", 100, 200);
        newer["parts"] = serde_json::json!([{"type": "text", "text": "新"}]);
        let merged = merge_thread_messages(&msgs_json(&[older]), &msgs_json(&[newer]));
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["parts"][0]["text"].as_str().unwrap(), "新");

        // 反过来 remote 更旧：保本地
        let mut older2 = msg("a", 100, 100);
        older2["parts"] = serde_json::json!([{"type": "text", "text": "旧"}]);
        let mut newer2 = msg("a", 100, 200);
        newer2["parts"] = serde_json::json!([{"type": "text", "text": "新"}]);
        let merged2 = merge_thread_messages(&msgs_json(&[newer2]), &msgs_json(&[older2]));
        assert_eq!(merged2[0]["parts"][0]["text"].as_str().unwrap(), "新");
    }

    #[test]
    fn test_merge_empty_sides() {
        // 空边：local 空 / remote 空 / 两边都空
        let remote = msgs_json(&[msg("a", 100, 100)]);
        assert_eq!(ids(&merge_thread_messages("[]", &remote)), vec!["a"]);
        assert_eq!(ids(&merge_thread_messages(&remote, "[]")), vec!["a"]);
        assert!(merge_thread_messages("[]", "[]").is_empty());
        // 非法 JSON 也不炸
        assert!(merge_thread_messages("not-json", "[]").is_empty());
    }

    #[test]
    fn test_remote_wins() {
        assert!(remote_wins(None, 100));
        assert!(remote_wins(Some(99), 100));
        assert!(!remote_wins(Some(100), 100)); // 相等不赢 → 重放幂等
        assert!(!remote_wins(Some(101), 100));
    }

    #[test]
    fn test_merge_thread_row_fields() {
        // 行级：messages 并集；title 等字段 LWW
        let local = ThreadRowData {
            id: "t".into(),
            book_id: None,
            metadata: "{}".into(),
            title: "旧标题".into(),
            messages: msgs_json(&[msg("a", 100, 100)]),
            starred: 0,
            created_at: 100,
            updated_at: 200,
        };
        let remote = ThreadRowData {
            title: "新标题".into(),
            messages: msgs_json(&[msg("b", 300, 300)]),
            updated_at: 300,
            ..local.clone()
        };
        let merged = merge_thread_row(Some(&local), &remote);
        assert_eq!(merged.title, "新标题"); // remote 更新，字段取 remote
        assert_eq!(ids(&parse_messages(&merged.messages)), vec!["a", "b"]); // 消息并集

        // local 更新：字段保 local，消息仍并集
        let remote_older = ThreadRowData {
            title: "更旧标题".into(),
            messages: msgs_json(&[msg("b", 300, 300)]),
            updated_at: 100,
            ..local.clone()
        };
        let merged2 = merge_thread_row(Some(&local), &remote_older);
        assert_eq!(merged2.title, "旧标题");
        assert_eq!(ids(&parse_messages(&merged2.messages)), vec!["a", "b"]);
    }
}
