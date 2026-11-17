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
    /// The question this reply asks, with the choices it suggests.
    pub ask: Option<Ask>,
    pub created_at: i64,
}

/// A question the model asks the user, with the choices it suggests; the first is its suggestion.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "AiAsk")]
pub struct Ask {
    pub question: String,
    pub options: Vec<String>,
    #[serde(default)]
    pub recommended: usize,
}

/// A question and its choices, as the model gave them, once they make sense; the suggested choice
/// first, or nothing when they do not.
fn tidy_ask(ask: Ask) -> Option<Ask> {
    let question = ask.question.trim();
    if question.is_empty() || question.chars().count() > 300 {
        return None;
    }
    let mut options: Vec<String> = Vec::new();
    for option in ask.options {
        let option = option.trim().to_owned();
        if option.is_empty() || option.chars().count() > 200 || options.contains(&option) {
            continue;
        }
        options.push(option);
    }
    if !(2..=6).contains(&options.len()) {
        return None;
    }
    let at = ask.recommended.min(options.len() - 1);
    let first = options.remove(at);
    options.insert(0, first);
    Some(Ask { question: question.to_owned(), options, recommended: 0 })
}

/// One conversation of the user's, for the page that manages them: where it is, how much was said,
/// and the last word.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, rename = "AiChatSummary")]
pub struct Summary {
    pub folder_id: Option<FolderId>,
    pub messages: usize,
    pub last_role: Role,
    pub last: String,
    pub updated_at: i64,
}

/// The conversations the user has, newest first, a row for each folder and the root.
pub fn summaries(c: &Connection, owner: &str) -> rusqlite::Result<Vec<Summary>> {
    let mut stmt = c.prepare_cached(
        "SELECT m1.folder_id, COUNT(*), MAX(m1.created_at),
            (SELECT m2.role FROM ai_messages m2
              WHERE m2.owner_id = m1.owner_id AND m2.folder_id IS m1.folder_id
              ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1),
            (SELECT substr(m2.content, 1, 160) FROM ai_messages m2
              WHERE m2.owner_id = m1.owner_id AND m2.folder_id IS m1.folder_id
              ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1)
         FROM ai_messages m1 WHERE m1.owner_id = ?1
         GROUP BY m1.folder_id ORDER BY MAX(m1.created_at) DESC",
    )?;
    let rows = stmt.query_map([owner], |r| {
        let role = Role::parse(&r.get::<_, String>(3)?).ok_or(rusqlite::Error::InvalidQuery)?;
        Ok(Summary {
            folder_id: r.get(0)?,
            messages: r.get::<_, i64>(1)? as usize,
            last_role: role,
            last: r.get(4)?,
            updated_at: r.get(2)?,
        })
    })?;
    rows.collect()
}

/// The conversation in `folder` (`None` for the root), oldest first.
pub fn load(c: &Connection, owner: &str, folder: Option<FolderId>) -> rusqlite::Result<Vec<Message>> {
    let mut stmt = c.prepare_cached(
        "SELECT id, role, content, created_at, job_id, ask FROM ai_messages
         WHERE owner_id = ?1 AND folder_id IS ?2 ORDER BY created_at DESC, id DESC LIMIT ?3",
    )?;
    let mut messages: Vec<Message> = stmt
        .query_map(params![owner, folder, i64::try_from(KEPT).expect("fits")], |r| {
            let role = Role::parse(&r.get::<_, String>(1)?).ok_or(rusqlite::Error::InvalidQuery)?;
            let ask = r.get::<_, Option<String>>(5)?.and_then(|a| serde_json::from_str(&a).ok());
            Ok(Message { id: r.get(0)?, role, content: r.get(2)?, created_at: r.get(3)?, job_id: r.get(4)?, ask })
        })?
        .collect::<Result<_, _>>()?;
    messages.reverse();
    Ok(messages)
}

/// Keeps `content` as the latest message of the conversation, and gives it back with its id. Older
/// ones than the `KEPT` latest go: they are no longer shown, and the table would only grow.
pub fn add(c: &Connection, owner: &str, folder: Option<FolderId>, role: Role, content: &str, now: i64) -> rusqlite::Result<Message> {
    let message = Message { id: Uuid::now_v7().to_string(), role, content: content.to_owned(), job_id: None, ask: None, created_at: now };
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

/// Ties a reply to the tidying its changes wait on, and the question it asks.
pub fn attach(c: &Connection, message: &str, job: Option<AiJobId>, ask: Option<&Ask>) -> rusqlite::Result<()> {
    let ask = ask.map(|a| serde_json::to_string(a).expect("ask serializes"));
    c.execute("UPDATE ai_messages SET job_id = ?2, ask = ?3 WHERE id = ?1", params![message, job, ask])?;
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
/// The marker a reply ends with when the model asks the user a question, with choices.
const ASK: &str = "[[ASK]]";
/// As much of the end as a marker may need, held back until it is clear.
const HOLD: usize = MARKER.len();

/// Holds back the end of a reply that may be a marker, and takes the markers out of what is shown.
#[derive(Default)]
pub struct Hidden {
    pending: String,
    shown: String,
    changes: bool,
    /// Whether the reply has reached its question, whose choices are not shown as they come.
    asking: bool,
    ask_json: String,
}

impl Hidden {
    /// What of `piece` may be shown now; the rest waits for the next piece, should the marker be
    /// split across them.
    pub fn push(&mut self, piece: &str) -> String {
        if self.asking {
            self.ask_json.push_str(piece);
            return String::new();
        }
        self.pending.push_str(piece);
        // The question is the end of the reply: what follows is its JSON, never shown as it comes.
        if let Some(i) = self.pending.find(ASK) {
            self.asking = true;
            self.changes = false;
            let mut out = self.pending[..i].trim_end().to_owned();
            self.ask_json = self.pending[i + ASK.len()..].to_owned();
            self.pending.clear();
            while let Some(j) = out.find(MARKER) {
                out.replace_range(j..j + MARKER.len(), "");
            }
            self.shown.push_str(&out);
            return out;
        }
        if self.pending.len() <= HOLD {
            return String::new();
        }
        let mut cut = self.pending.len() - HOLD;
        while !self.pending.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut out = self.pending[..cut].to_string();
        self.pending = self.pending[cut..].to_string();
        // A marker may start at the very end of what is let out: keep its beginning back.
        let keep = [MARKER, ASK].iter().filter_map(|m| (1..m.len()).rev().find(|&n| out.ends_with(&m[..n]))).max().unwrap_or(0);
        if keep > 0 {
            let tail = out.split_off(out.len() - keep);
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
        if self.asking {
            self.ask_json.push_str(&std::mem::take(&mut self.pending));
            self.shown = self.shown.trim_end().to_owned();
            return String::new();
        }
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

    /// The question the reply asked, once it makes sense; the suggested choice first.
    pub fn ask(&self) -> Option<Ask> {
        if !self.asking {
            return None;
        }
        let text = self.ask_json.trim();
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        if end <= start {
            return None;
        }
        let ask: Ask = serde_json::from_str(&text[start..=end]).ok()?;
        tidy_ask(ask)
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
- 用户让你新建、修改、完成、删除、移动事项，或调整先后和顺序时，先弄清他的意思：要求不清楚就先直接说出你的建议和理由，再用 ask 工具给出选项；清楚时用一两句话说明你打算怎么改，系统会把修改列在回复下面，由用户逐条确认后再执行。
- 需要用户确认或选择时，先说出你的建议和理由，然后用 ask 工具：在回复的最后另起一行写 [[ASK]]，后面紧跟一行 JSON，形如 {"question":"要改到哪一天？","options":["周五","周六","下周一"],"recommended":0}。question 一句话；options 给 2–6 个，每个都是可以直接发给你的完整回答；recommended 是你建议的选项下标，服务端会把它放到第一个并标“建议”。不要把 JSON 放在代码块里，这一行后面不要再写别的，一次只问一个问题。
- 这一轮用了 ask 就不要写 [[CHANGES]]；等用户答完、意思清楚了，再在下一轮说明打算怎么改。
- 如果这一轮要让事项发生变化，在回复的最后另起一行只写 [[CHANGES]]，不要解释这个标记，不要放在代码块里，也不要在别的位置写；只是回答问题、没有要改的，不要写。回复里不要提这个标记，也不要说“已改好”。
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
    fn hides_a_question_and_puts_its_suggestion_first() {
        let mut hidden = Hidden::default();
        let mut shown = String::new();
        for piece in [
            "我建议改到周六，",
            "这样不耽误下周。[[A",
            "SK]]{\"question\":\"要改到哪一天？\",\"options\":[\"周五\",\"周六\",\"下周一\"],\"recommended\":1}",
        ] {
            shown.push_str(&hidden.push(piece));
        }
        shown.push_str(&hidden.finish());
        assert_eq!(shown, "我建议改到周六，这样不耽误下周。");
        assert!(!hidden.changes());
        let ask = hidden.ask().expect("the question");
        assert_eq!(ask.question, "要改到哪一天？");
        assert_eq!(ask.options, ["周六", "周五", "下周一"]);
        assert_eq!(ask.recommended, 0);
    }

    #[test]
    fn a_long_conversation_still_fits_a_request() {
        use super::{Message, Role, request};
        let messages: Vec<Message> = (0..20)
            .map(|i| Message {
                id: i.to_string(),
                role: if i % 2 == 0 { Role::User } else { Role::Assistant },
                content: "字".repeat(1_200),
                job_id: None,
                ask: None,
                created_at: i,
            })
            .collect();
        let asked = request(&messages);
        assert!(asked.as_str().chars().count() <= 10_000);
        assert!(asked.as_str().contains("助手："));
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
