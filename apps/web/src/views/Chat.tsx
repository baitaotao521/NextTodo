// A conversation with the model about a folder's tasks, answered as it is written, and kept on the
// server so that another device carries it on. A folder has many of them, listed on the left. See
// docs/ai.md#对话.

import { CircleAlert, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Fragment, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, apiStream } from "../api/http";
import type { AiAsk } from "../api/types/AiAsk";
import type { AiChatId } from "../api/types/AiChatId";
import type { AiChatSummary } from "../api/types/AiChatSummary";
import type { AiMessage } from "../api/types/AiMessage";
import type { FolderId } from "../api/types/FolderId";
import { localAiConfig } from "../ai";
import { ChatEvents } from "../domain/chat";
import { ago, localTime } from "../domain/dates";
import { useSession, useView } from "../session";
import { Modal, forUser, useFeedback } from "../ui/feedback";
import { composing } from "../ui/keys";
import { Description as Markdown } from "../ui/lazy-markdown";
import { Proposal } from "./suggestions";

const endpoint = (chat: AiChatId) => `/ai/chat?chat_id=${chat}`;

/** The chats about `folder`: starting a new one, carrying on `chat`, or the newest there. */
export function AiChat({
  folder,
  initial,
  chat,
  onClose,
}: {
  folder: FolderId | null;
  initial?: string;
  chat?: AiChatId;
  onClose(): void;
}) {
  const { user } = useSession();
  const { board } = useView();
  const { snack, confirm } = useFeedback();
  const [chats, setChats] = useState<AiChatSummary[] | null>(null);
  const [chatId, setChatId] = useState<AiChatId | null>(null);
  const [messages, setMessages] = useState<AiMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  /** The answer being written; in `messages` once it is done. */
  const [answering, setAnswering] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stop = useRef<AbortController>(undefined);
  const started = useRef(false);
  /** Guarded here too: two submits in a row would otherwise go out before the first is under way. */
  const sending = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const loadMessages = (id: AiChatId) => {
    setMessages(null);
    setError("");
    api<AiMessage[]>("GET", endpoint(id)).then(setMessages, (e) => {
      setMessages([]);
      setError(forUser("读取对话", e));
    });
  };

  const reloadChats = async () => {
    try {
      setChats((await api<AiChatSummary[]>("GET", "/ai/chats")).filter((c) => c.folder_id === folder));
    } catch (e) {
      setError(forUser("读取对话", e));
    }
  };

  // The folder's conversations, newest first; open the one asked for, or the newest, or a new one.
  useEffect(() => {
    let here = true;
    started.current = false;
    api<AiChatSummary[]>("GET", "/ai/chats").then(
      (all) => {
        if (!here) return;
        const inFolder = all.filter((c) => c.folder_id === folder);
        setChats(inFolder);
        const pick = initial ? null : chat && inFolder.some((c) => c.id === chat) ? chat : (inFolder[0]?.id ?? null);
        setChatId(pick);
        if (pick) {
          loadMessages(pick);
        } else {
          setMessages([]);
        }
      },
      (e) => {
        if (!here) return;
        setChats([]);
        setMessages([]);
        setError(forUser("读取对话", e));
      },
    );
    return () => {
      here = false;
      stop.current?.abort();
    };
  }, [folder, chat, initial]);

  // At the newest, and again as an answer is written.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, answering]);

  // As tall as what is written, up to the height the style allows.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  // Said once the conversation it joins is here, so that the history goes with it.
  useEffect(() => {
    if (started.current || !initial || messages === null) return;
    started.current = true;
    void say(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- said once, when that is here
  }, [initial, messages]);

  async function say(text: string) {
    const said = text.trim();
    if (!said || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setAnswering("");
    setDraft("");
    setMessages((all) => [
      ...(all ?? []),
      {
        id: `local-${Date.now()}`,
        chat_id: chatId ?? "local",
        role: "user",
        content: said,
        job_id: null,
        ask: null,
        created_at: Date.now(),
      },
    ]);
    const abort = new AbortController();
    stop.current = abort;
    const config = localAiConfig(user.id);
    let answer = "";
    let messageId: string | undefined;
    let jobId: string | null = null;
    let ask: AiAsk | null = null;
    let answerChatId = chatId;
    try {
      const res = await apiStream(
        "/ai/chat",
        {
          ...(folder && { folder_id: folder }),
          ...(chatId ? { chat_id: chatId } : { new_chat: true }),
          text: said,
          local_time: localTime(new Date()),
          ...(config && { config }),
        },
        abort.signal,
      );
      if (!res.ok) {
        const body = await res.text();
        let told = `发送失败（${res.status}）`;
        try {
          const e = JSON.parse(body) as { message?: string };
          if (e.message) told = e.message;
        } catch {
          // A proxy's page says nothing the user can use.
        }
        setError(told);
        return;
      }
      if (!res.body) throw new Error("the answer has no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const events = new ChatEvents();
      const take = (chunk: string) => {
        for (const event of events.push(chunk)) {
          if (event.chat_id) {
            answerChatId = event.chat_id;
            setChatId(event.chat_id);
          }
          if (event.delta) {
            answer += event.delta;
            setAnswering(answer);
          } else if (event.error) {
            setError(event.error);
          } else if (event.done) {
            messageId = event.message_id;
            jobId = event.job_id ?? null;
            ask = event.ask ?? null;
          }
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        take(decoder.decode(value, { stream: true }));
      }
      take(decoder.decode());
    } catch (e) {
      // Closed by the user: not worth telling.
      const name = typeof e === "object" && e !== null ? (e as { name?: string }).name : undefined;
      if (name !== "AbortError") setError(forUser("发送消息", e));
    } finally {
      if (answer || jobId || ask) {
        setMessages((all) => [
          ...(all ?? []),
          {
            id: messageId ?? `local-${Date.now()}`,
            chat_id: answerChatId ?? "local",
            role: "assistant",
            content: answer,
            job_id: jobId,
            ask,
            created_at: Date.now(),
          },
        ]);
      }
      setAnswering("");
      setBusy(false);
      sending.current = false;
      stop.current = undefined;
      if (answerChatId) void reloadChats();
    }
  }

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    void say(draft);
  };

  /** A new, unsaved conversation; the first thing said makes it on the server. */
  const newChat = () => {
    if (busy) return;
    started.current = true;
    setChatId(null);
    setMessages([]);
    setAnswering("");
    setError("");
    setDraft("");
    area.current?.focus();
  };

  const selectChat = (id: AiChatId) => {
    if (busy || id === chatId) return;
    started.current = true;
    setChatId(id);
    setAnswering("");
    setDraft("");
    loadMessages(id);
  };

  const clear = async () => {
    if (!chatId) return;
    if (!(await confirm({ title: "清空这段对话？", body: "服务器上的记录和还没确认的修改一并删除，不能撤销。", ok: "清空", danger: true }))) return;
    try {
      await api("DELETE", endpoint(chatId));
      setMessages([]);
      setChatId(null);
      setAnswering("");
      setError("");
      await reloadChats();
      snack("已清空对话");
    } catch (e) {
      snack(forUser("清空对话", e));
    }
  };

  const now = new Date();
  const place = folder && board.folder(folder) ? board.place(folder) : board.folderName(null);
  return (
    <Modal
      title="AI 对话"
      wide
      focus={area}
      onClose={onClose}
      footer={
        <div className="chat-foot">
          <div className="chat-tools">
            <span className="chat-place">{place}</span>
            <button type="button" className="text-btn" onClick={clear} disabled={!chatId || busy}>
              <Trash2 size={14} /> 清空
            </button>
          </div>
          <form className="chat-compose" onSubmit={send}>
            <textarea
              ref={area}
              rows={1}
              value={draft}
              placeholder="问点什么，或说说要改哪些事项…"
              aria-label="发给 AI 的话"
              enterKeyHint="send"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
                  e.preventDefault();
                  e.currentTarget.form!.requestSubmit();
                }
              }}
            />
            <button type="submit" className="filled-btn" disabled={!draft.trim() || busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : "发送"}
            </button>
          </form>
        </div>
      }
    >
      <div className="chat-shell">
        <aside className="chat-sessions">
          <button type="button" className="tonal-btn chat-new" onClick={newChat} disabled={busy}>
            <Plus size={15} /> 新对话
          </button>
          <div className="chat-session-list">
            {chats === null ? (
              <p className="chat-session-empty">
                <LoaderCircle className="spin" size={14} /> 读取中…
              </p>
            ) : chats.length === 0 ? (
              <p className="chat-session-empty">还没有对话</p>
            ) : (
              chats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chat-session${c.id === chatId ? " on" : ""}`}
                  disabled={busy}
                  onClick={() => selectChat(c.id)}
                >
                  <span className="chat-session-title">{c.title || "新对话"}</span>
                  <span className="chat-session-time">{ago(c.updated_at, now)}</span>
                </button>
              ))
            )}
          </div>
        </aside>
        <div className="chat-main">
          <div className="chat-log">
            {messages === null ? (
              <p className="empty">
                <LoaderCircle className="spin" size={16} /> 正在读取对话…
              </p>
            ) : (
              <>
                {!messages.length && !answering && (
                  <p className="chat-hint">
                    AI 能看到这个文件夹里未完成的事项和你的说明。让它新建、修改、完成、删除或移动事项都可以；它会说明打算怎么改，并在回复下面列出待确认的修改，由你确认后应用。
                  </p>
                )}
                {messages.map((m, i) => (
                  <Fragment key={m.id}>
                    {m.content && (
                      <div className={`chat-msg ${m.role}`}>
                        {m.role === "assistant" ? (
                          <Suspense fallback={<p className="chat-text">{m.content}</p>}>
                            <Markdown source={m.content} onChange={() => {}} />
                          </Suspense>
                        ) : (
                          <p className="chat-text">{m.content}</p>
                        )}
                      </div>
                    )}
                    {m.role === "assistant" && m.job_id && <Proposal id={m.job_id} board={board} />}
                    {m.role === "assistant" && m.ask && i === messages.length - 1 && (
                      <AskOptions ask={m.ask} busy={busy} onPick={(option) => void say(option)} />
                    )}
                  </Fragment>
                ))}
                {answering && (
                  <div className="chat-msg assistant writing">
                    <Suspense fallback={<p className="chat-text">{answering}</p>}>
                      <Markdown source={answering} onChange={() => {}} />
                    </Suspense>
                  </div>
                )}
                {busy && !answering && (
                  <p className="chat-hint">
                    <LoaderCircle className="spin" size={15} /> 正在想…
                  </p>
                )}
                {error && (
                  <p className="chat-error" role="alert">
                    <CircleAlert size={15} /> {error}
                  </p>
                )}
                <div ref={end} />
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The question a reply asks, with its suggested choices: picking one says it back. */
function AskOptions({ ask, busy, onPick }: { ask: AiAsk; busy: boolean; onPick(option: string): void }) {
  return (
    <section className="chat-ask" aria-label="AI 想确认">
      <p className="chat-ask-q">{ask.question}</p>
      <div className="chat-ask-options">
        {ask.options.map((option, i) => (
          <button
            key={`${i}-${option}`}
            type="button"
            className={`chat-ask-option${i === ask.recommended ? " recommended" : ""}`}
            disabled={busy}
            onClick={() => onPick(option)}
          >
            <span>{option}</span>
            {i === ask.recommended && <span className="chat-ask-badge">建议</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
