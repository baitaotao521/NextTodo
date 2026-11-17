// The AI conversations kept on the server, to read and clear. See docs/ai.md#对话.

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

const endpoint = (folder: FolderId | null) => `/ai/chat${folder ? `?folder_id=${folder}` : ""}`;

export function ChatLog() {
  const { board } = useView();
  const { confirm, snack } = useFeedback();
  const [chats, setChats] = useState<AiChatSummary[] | null>(null);
  const [selected, setSelected] = useState<FolderId | null | undefined>(undefined);
  const [messages, setMessages] = useState<AiMessage[] | null>(null);
  const [search, setSearch] = useState("");
  /** The chat opened over this page; `undefined` when none, `null` for the root. */
  const [open, setOpen] = useState<FolderId | null | undefined>(undefined);
  const [error, setError] = useState("");
  const now = new Date();

  const load = async () => {
    try {
      setChats(await api<AiChatSummary[]>("GET", "/ai/chats"));
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

  const show = (id: FolderId | null) => {
    setSelected(id);
    setMessages(null);
    setError("");
    api<AiMessage[]>("GET", endpoint(id)).then(setMessages, (e) => setError(forUser("读取对话", e)));
  };

  const clear = async (id: FolderId | null) => {
    if (!(await confirm({ title: "清空这段对话？", body: "服务器上的记录和还没确认的修改一并删除，不能撤销。", ok: "清空", danger: true }))) return;
    try {
      await api("DELETE", endpoint(id));
      snack("已清空对话");
      if (selected === id) setMessages([]);
      await load();
    } catch (e) {
      snack(forUser("清空对话", e));
    }
  };

  const query = search.trim();
  const shown = (chats ?? []).filter((c) => !query || name(c.folder_id).includes(query) || c.last.includes(query));

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
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索文件夹或最后一句" autoComplete="off" />
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
                key={c.folder_id ?? "root"}
                className={`row chatlog-row${c.folder_id === selected ? " selected" : ""}`}
                onClick={() => show(c.folder_id)}
              >
                <div className="row-inner">
                  <span className="token-ic">
                    <MessageSquare size={18} />
                  </span>
                  <span className="folder-main">
                    <span>{name(c.folder_id)}</span>
                    <span className="folder-sub">
                      {c.messages} 条消息 · {ago(c.updated_at, now)}
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
                <h2>{name(selected)}</h2>
                <p>{messages === null ? "正在读取…" : `${messages.length} 条消息`}</p>
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
      {open !== undefined && (
        <AiChat
          folder={open}
          onClose={() => {
            const id = open;
            setOpen(undefined);
            void load();
            if (id !== undefined) show(id);
          }}
        />
      )}
    </div>
  );
}
