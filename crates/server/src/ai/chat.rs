//! Talking with the model about a folder's tasks: the conversation kept, and what the model is
//! shown of it. See `docs/ai.md#对话`.

use nexttodo_core::board::Board;
use nexttodo_core::model::{AiJobId, FolderId, JobText, Task};
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
    /// The tidying this reply's changes wait on, when it had any.
    pub job_id: Option<AiJobId>,
    pub created_at: i64,
}

/// The conversation in `folder` (`None` for the root), oldest first.
pub fn load(c: &Connection, owner: &str, folder: Option<FolderId>) -> rusqlite::Result<Vec<Message>> {
    let mut stmt = c.prepare_cached(
        "SELECT id, role, content, created_at, job_id FROM ai_messages
         WHERE owner_id = ?1 AND folder_id IS ?2 ORDER BY created_at DESC, id DESC LIMIT ?3",
    )?;
    let mut messages: Vec<Message> = stmt
        .query_map(params![owner, folder, i64::try_from(KEPT).expect("fits")], |r| {
            let role = Role::parse(&r.get::<_, String>(1)?).ok_or(rusqlite::Error::InvalidQuery)?;
            Ok(Message { id: r.get(0)?, role, content: r.get(2)?, created_at: r.get(3)?, job_id: r.get(4)? })
        })?
        .collect::<Result<_, _>>()?;
    messages.reverse();
    Ok(messages)
}

/// Keeps `content` as the latest message of the conversation, and gives it back with its id. Older
/// ones than the `KEPT` latest go: they are no longer shown, and the table would only grow.
pub fn add(c: &Connection, owner: &str, folder: Option<FolderId>, role: Role, content: &str, now: i64) -> rusqlite::Result<Message> {
    let message = Message { id: Uuid::now_v7().to_string(), role, content: content.to_owned(), job_id: None, created_at: now };
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

/// Ties a reply to the tidying its changes wait on.
pub fn attach_job(c: &Connection, message: &str, job: AiJobId) -> rusqlite::Result<()> {
    c.execute("UPDATE ai_messages SET job_id = ?2 WHERE id = ?1", params![message, job])?;
    Ok(())
}

/// The conversation as a tidying's request: the user's last word decides, and the turns before it
/// say what they mean. Its start goes first when it does not fit.
pub fn request(messages: &[Message]) -> JobText {
    const HEAD: &str = "以下是用户和 AI 助手的对话，按用户最后的要求整理，前面的对话只用来理解他的意思：\n\n";
    let body = messages
        .iter()
        .map(|m| format!("{}：{}", if m.role == Role::User { "用户" } else { "助手" }, m.content.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let room = 10_000 - HEAD.chars().count();
    let chars: Vec<char> = body.chars().collect();
    let body = if chars.len() > room { format!("…{}", chars[chars.len() - room + 1..].iter().collect::<String>()) } else { body };
    JobText::try_from(format!("{HEAD}{body}")).expect("the request fits")
}

/// The marker a reply ends with when the turn changes the folder, which the user never sees.
const MARKER: &str = "[[CHANGES]]";

/// Holds back the end of a reply that may be the marker, and takes the marker out of what is shown.
#[derive(Default)]
pub struct Hidden {
    pending: String,
    shown: String,
    changes: bool,
}

impl Hidden {
    /// What of `piece` may be shown now; the rest waits for the next piece, should the marker be
    /// split across them.
    pub fn push(&mut self, piece: &str) -> String {
        self.pending.push_str(piece);
        if self.pending.len() <= MARKER.len() {
            return String::new();
        }
        let mut cut = self.pending.len() - MARKER.len();
        while !self.pending.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut out = self.pending[..cut].to_string();
        self.pending = self.pending[cut..].to_string();
        // A marker may start at the very end of what is let out: keep its beginning back.
        if let Some(n) = (1..MARKER.len()).rev().find(|&n| out.ends_with(&MARKER[..n])) {
            let tail = out.split_off(out.len() - n);
            self.pending.insert_str(0, &tail);
        }
        while let Some(i) = out.find(MARKER) {
            self.changes = true;
            out.replace_range(i..i + MARKER.len(), "");
        }
        self.shown.push_str(&out);
        out
    }

    /// What is left, once the reply is over.
    pub fn finish(&mut self) -> String {
        let mut out = std::mem::take(&mut self.pending);
        while let Some(i) = out.find(MARKER) {
            self.changes = true;
            out.replace_range(i..i + MARKER.len(), "");
        }
        let out = out.trim_end().to_owned();
        self.shown.push_str(&out);
        self.shown = self.shown.trim_end().to_owned();
        out
    }

    pub fn shown(&self) -> &str {
        &self.shown
    }

    pub fn changes(&self) -> bool {
        self.changes
    }
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
- 用户让你新建、修改、完成、删除、移动事项，或调整先后和顺序时，先弄清他的意思：要求不清楚就先问一句；清楚时用一两句话说明你打算怎么改，系统会把修改列在回复下面，由用户逐条确认后再执行。
- 如果这一轮要让事项发生变化，在回复的最后另起一行只写 [[CHANGES]]，不要解释这个标记，也不要在别的位置写；只是回答问题、没有要改的，不要写。回复里不要提这个标记，也不要说“已改好”。
- 你不能直接改动事项。
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

#[cfg(test)]
mod tests {
    use super::Hidden;

    #[test]
    fn takes_the_marker_out_of_an_answer_split_across_pieces() {
        let mut hidden = Hidden::default();
        let mut shown = String::new();
        for piece in ["好的，改到周五。", "[[CHAN", "GES]]"] {
            shown.push_str(&hidden.push(piece));
        }
        shown.push_str(&hidden.finish());
        assert_eq!(shown, "好的，改到周五。");
        assert!(hidden.changes());
    }

    #[test]
    fn shows_an_answer_without_a_marker_as_it_is() {
        let mut hidden = Hidden::default();
        let mut shown = String::new();
        for piece in ["没有", "要改的。"] {
            shown.push_str(&hidden.push(piece));
        }
        shown.push_str(&hidden.finish());
        assert_eq!(shown, "没有要改的。");
        assert!(!hidden.changes());
    }
}
