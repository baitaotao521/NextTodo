//! Talking with the model about a folder's tasks: the conversation kept, and what the model is
//! shown of it. See `docs/ai.md#对话`.

use nexttodo_core::board::Board;
use nexttodo_core::model::{FolderId, Task};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;
use uuid::Uuid;

use super::llm::Prompt;
use super::organize::due_text;

/// How many of the folder's open tasks the model is shown.
const SHOWN: usize = 50;
/// How much of the conversation it is shown: the latest messages, up to this many and this long.
const HISTORY: usize = 20;
const HISTORY_CHARS: usize = 12_000;
/// How many messages a conversation keeps, the latest.
const KEPT: usize = 200;

/// Who said it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "AiRole")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }

    fn parse(s: &str) -> Option<Role> {
        [Role::User, Role::Assistant].into_iter().find(|r| r.as_str() == s)
    }
}

#[derive(Clone, Serialize, TS)]
#[ts(export, rename = "AiMessage")]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub content: String,
    pub created_at: i64,
}

/// The conversation in `folder` (`None` for the root), oldest first.
pub fn load(c: &Connection, owner: &str, folder: Option<FolderId>) -> rusqlite::Result<Vec<Message>> {
    let mut stmt = c.prepare_cached(
        "SELECT id, role, content, created_at FROM ai_messages
         WHERE owner_id = ?1 AND folder_id IS ?2 ORDER BY created_at DESC, id DESC LIMIT ?3",
    )?;
    let mut messages: Vec<Message> = stmt
        .query_map(params![owner, folder, i64::try_from(KEPT).expect("fits")], |r| {
            let role = Role::parse(&r.get::<_, String>(1)?).ok_or(rusqlite::Error::InvalidQuery)?;
            Ok(Message { id: r.get(0)?, role, content: r.get(2)?, created_at: r.get(3)? })
        })?
        .collect::<Result<_, _>>()?;
    messages.reverse();
    Ok(messages)
}

/// Keeps `content` as the latest message of the conversation, and gives it back with its id. Older
/// ones than the `KEPT` latest go: they are no longer shown, and the table would only grow.
pub fn add(c: &Connection, owner: &str, folder: Option<FolderId>, role: Role, content: &str, now: i64) -> rusqlite::Result<Message> {
    let message = Message { id: Uuid::now_v7().to_string(), role, content: content.to_owned(), created_at: now };
    c.execute(
        "INSERT INTO ai_messages (id, owner_id, folder_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![message.id, owner, folder, role.as_str(), message.content, message.created_at],
    )?;
    c.execute(
        "DELETE FROM ai_messages WHERE owner_id = ?1 AND folder_id IS ?2 AND id NOT IN (
             SELECT id FROM ai_messages WHERE owner_id = ?1 AND folder_id IS ?2 ORDER BY created_at DESC, id DESC LIMIT ?3
         )",
        params![owner, folder, i64::try_from(KEPT).expect("fits")],
    )?;
    Ok(message)
}

pub fn clear(c: &Connection, owner: &str, folder: Option<FolderId>) -> rusqlite::Result<()> {
    c.execute("DELETE FROM ai_messages WHERE owner_id = ?1 AND folder_id IS ?2", params![owner, folder])?;
    Ok(())
}

/// The instructions: what the model is shown, and how it answers.
const SYSTEM: &str = r#"你是 NextTodo 里的 AI 助手，在一个文件夹里帮用户管理待办事项。输入是一个 JSON 对象：
- local_time：用户发这条消息时的本地时间；
- folder：这个文件夹；
- open_tasks：文件夹里未完成的事项，number 是编号，requires 是要先做完的事项的编号，due 是截止时间；
- messages：你们的对话，最后一条是用户刚说的；
- notes（可能有）：用户写给你的长期要求，按文件夹从外到内排列。

怎么回答：
- 用简体中文（用户用别的语言时用那种语言），简洁、直接，可以用 Markdown，不要长篇大论。
- 提到已有事项时带上编号，如 #12；不要编造不存在的事项、时间或完成情况。
- 用户让你新建、修改、完成、删除、移动事项，或调整先后和顺序时，先弄清他的意思：要求不清楚就先问一句；清楚时用一两句话说明你打算怎么改，然后提醒他点“生成建议”，由他逐条确认后再执行。
- 你不能直接改动事项，也不要说已经改好了。
- notes 是用户写给你的长期要求，回答和说明打算怎么改时照着做；内层的和外层的不一致时，以内层的为准。

只回复给用户看的文字。"#;

const NOTES: &str = "输入里还有 notes：用户写给你的长期要求，按文件夹从外到内排列。回答和说明打算怎么改时照着做；它们和上面的说法不一致时以它们为准，内层的和外层的不一致时以内层的为准。它们不扩大这次要做的事。";

/// The chat for `folder` in `board`, with the user's `notes` along the way to it and the
/// conversation `history`, whose last message is the user's new one.
pub fn prompt(board: &Board, folder: Option<FolderId>, notes: &[Value], local_time: &str, history: &[Message]) -> Prompt {
    let open: Vec<&Task> = board.tasks_in(folder).into_iter().filter(|t| t.done_at.is_none()).take(SHOWN).collect();
    let numbers: Vec<i64> = open.iter().map(|t| t.number).collect();
    let tasks: Vec<Value> = open
        .iter()
        .map(|t| {
            let mut v = json!({ "number": t.number, "title": t.title.as_str() });
            if let Some(d) = &t.due {
                v["due"] = due_text(d).into();
            }
            let requires: Vec<i64> = board.before(t).iter().map(|b| b.number).filter(|n| numbers.contains(n)).collect();
            if !requires.is_empty() {
                v["requires"] = requires.into();
            }
            v
        })
        .collect();
    // The latest messages that fit: the model needs the end of the conversation most.
    let mut shown = Vec::new();
    let mut budget = HISTORY_CHARS;
    for m in history.iter().rev().take(HISTORY) {
        let len = m.content.chars().count();
        if len > budget {
            break;
        }
        budget -= len;
        shown.push(json!({ "role": m.role, "content": m.content }));
    }
    shown.reverse();
    let mut input = json!({
        "local_time": local_time,
        "folder": board.path(folder),
        "open_tasks": tasks,
        "messages": shown,
    });
    if !notes.is_empty() {
        input["notes"] = notes.into();
    }
    // Not `organize::chat`, which would add the notes' instructions for a JSON answer as well.
    let system = if notes.is_empty() { SYSTEM.to_owned() } else { format!("{SYSTEM}\n\n{NOTES}") };
    Prompt { system, user: serde_json::to_string_pretty(&input).expect("JSON values serialize") }
}
