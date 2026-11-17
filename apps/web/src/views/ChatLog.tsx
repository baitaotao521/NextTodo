// The AI conversations kept on the server, to read and clear. See docs/ai.md#对话记录.

import { ChevronRight, CircleAlert, LoaderCircle, MessageSquare, Search, Sparkles, Trash2 } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { api } from "../api/http";
import type { AiChatSummary } from "../api/types/AiChatSummary";
import type { AiMessage } from "../api/types/AiMessage";
import type { FolderId } from "../api/types/FolderId";
import { ago, formatMoment } from "../domain/dates";
import { useView } from "../session";
import { forUser, useFeedback } from "../ui/feedback";
import { Description as Markdown } from "../ui/lazy-markdown";
import { AiChat } from "./Chat";

const endpoint = (chat: string) => `/ai/chat?chat_id=${chat}`;

export function ChatLog() {
  const { board } = useView();
  const { confirm, snack } = useFeedback();
  const [chats, setChats] = useState<AiChatSummary[] | null>(null);
  const [selected, setSelected] = useState<AiChatSummary | undefined>(undefined);
  const [messages, setMessages] = useState<AiMessage[] | null>(null);
  const [search, setSearch] = useState("");
  /** The conversation opened over this page. */
  const [open, setOpen] = useState<AiChatSummary | undefined>(undefined);
  const [error, setError] = useState("");
  const now = new Date();

  const load = async () => {
    try {
      const all = await api<AiChatSummary[]>("GET", "/ai/chats");
      setChats(all);
      setSelected((current) => (current ? all.find((c) => c.id === current.id) : undefined));
      setError("");
    } catch (e) {
      setChats([]);
      setError(forUser("读取对话记录", e));
    }
  };

  useEffect(() => {
    let here = true;
    api<AiChatSummary[]>("GET", "/ai/chats").then(
      (all) => here && setChats(all),
      (e) => {
        if (!here) return;
        setChats([]);
        setError(forUser("读取对话记录", e));
      },
    );
    return () => {
      here = false;
    };
  }, []);

  const name = (id: FolderId | null) => (id ? board.place(id) : board.folderName(null));

  const loadMessages = (id: string) => {
    setMessages(null);
    setError("");
    api<AiMessage[]>("GET", endpoint(id)).then(setMessages, (e) => {
      setMessages([]);
      setError(forUser("读取对话", e));
    });
  };

  const show = (chat: AiChatSummary) => {
    setSelected(chat);
    loadMessages(chat.id);
  };

  const clear = async (chat: AiChatSummary) => {
    if (!(await confirm({ title: "清空这段对话？", body: "服务器上的记录和还没确认的修改一并删除，不能撤销。", ok: "清空", danger: true }))) return;
    try {
      await api("DELETE", endpoint(chat.id));
      snack("已清空对话");
      setSelected(undefined);
      setMessages(null);
      await load();
    } catch (e) {
      snack(forUser("清空对话", e));
    }
  };

  const query = search.trim();
  const shown = (chats ?? []).filter(
    (c) => !query || (c.title || "新对话").includes(query) || name(c.folder_id).includes(query) || c.last.includes(query),
  );

  if (chats === null) {
    return (
      <p className="empty">
        <LoaderCircle className="spin" size={16} /> 正在读取对话记录…
      </p>
    );
  }

  return (
    <div className="chatlog">
      <section className="chatlog-list">
        <label className="search chatlog-search">
          <Search size={18} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索标题、文件夹或最后一句" autoComplete="off" />
        </label>
        {error && (
          <p className="chat-error" role="alert">
            <CircleAlert size={15} /> {error}
          </p>
        )}
        {shown.length === 0 ? (
          <p className="empty">{query ? "没有匹配的对话。" : "还没有对话。打开文件夹的 AI 整理，聊过之后会出现在这里。"}</p>
        ) : (
          <div className="group">
            {shown.map((c) => (
              <button
                key={c.id}
                className={`row chatlog-row${c.id === selected?.id ? " selected" : ""}`}
                onClick={() => show(c)}
              >
                <div className="row-inner">
                  <span className="token-ic">
                    <MessageSquare size={18} />
                  </span>
                  <span className="folder-main">
                    <span>{c.title || "新对话"}</span>
                    <span className="folder-sub">
                      {name(c.folder_id)} · {c.messages} 条消息 · {ago(c.updated_at, now)}
                    </span>
                    <span className="chatlog-last">
                      {c.last_role === "assistant" ? "AI：" : "你："}
                      {c.last || "（空）"}
                    </span>
                  </span>
                  <span className="chev">
                    <ChevronRight size={18} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="chatlog-detail">
        {selected === undefined ? (
          <p className="empty">选一段对话，查看和清理。</p>
        ) : (
          <>
            <header className="chatlog-head">
              <div>
                <h2>{selected.title || "新对话"}</h2>
                <p>
                  {name(selected.folder_id)} · {messages === null ? "正在读取…" : `${messages.length} 条消息`}
                </p>
              </div>
              <div className="chatlog-actions">
                <button className="tonal-btn" onClick={() => setOpen(selected)}>
                  <Sparkles size={15} /> 打开对话
                </button>
                <button className="text-btn danger-text" onClick={() => void clear(selected)} disabled={!messages?.length}>
                  <Trash2 size={14} /> 清空
                </button>
              </div>
            </header>
            {messages === null ? (
              <p className="empty">
                <LoaderCircle className="spin" size={16} /> 正在读取这条对话…
              </p>
            ) : messages.length === 0 ? (
              <p className="empty">这段对话已清空。</p>
            ) : (
              <div className="chatlog-messages">
                {messages.map((m) => (
                  <article key={m.id} className={`chatlog-msg ${m.role}`}>
                    <div className="chatlog-meta">
                      <span>{m.role === "user" ? "你" : "AI"}</span>
                      <time>{formatMoment(m.created_at, now)}</time>
                    </div>
                    {m.content &&
                      (m.role === "assistant" ? (
                        <Suspense fallback={<p>{m.content}</p>}>
                          <Markdown source={m.content} onChange={() => {}} />
                        </Suspense>
                      ) : (
                        <p>{m.content}</p>
                      ))}
                    {m.ask && (
                      <div className="chatlog-ask">
                        <b>AI 问：</b>
                        {m.ask.question}
                        <span className="chatlog-ask-options">{m.ask.options.join(" / ")}</span>
                      </div>
                    )}
                    {m.job_id && <p className="chatlog-note">这条回复曾生成待确认的修改。</p>}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      {open && (
        <AiChat
          folder={open.folder_id}
          chat={open.id}
          onClose={() => {
            const id = open.id;
            setOpen(undefined);
            void load();
            loadMessages(id);
          }}
        />
      )}
    </div>
  );
}
