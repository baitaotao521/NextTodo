// A conversation with the model about a folder's tasks, answered as it is written, and kept on the
// server so that another device carries it on. See docs/ai.md#对话.

import { CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import { Fragment, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, apiStream } from "../api/http";
import type { AiMessage } from "../api/types/AiMessage";
import type { FolderId } from "../api/types/FolderId";
import { localAiConfig } from "../ai";
import { ChatEvents } from "../domain/chat";
import { localTime } from "../domain/dates";
import { useSession, useView } from "../session";
import { Modal, forUser, useFeedback } from "../ui/feedback";
import { composing } from "../ui/keys";
import { Description as Markdown } from "../ui/lazy-markdown";
import { Proposal } from "./suggestions";

const ENDPOINT = (folder: FolderId | null) => `/ai/chat${folder ? `?folder_id=${folder}` : ""}`;

/** The chat about `folder`, starting with `initial` said, or carrying on what was said there. */
export function AiChat({ folder, initial, onClose }: { folder: FolderId | null; initial?: string; onClose(): void }) {
  const { user } = useSession();
  const { board } = useView();
  const { snack, confirm } = useFeedback();
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

  useEffect(() => {
    let here = true;
    api<AiMessage[]>("GET", ENDPOINT(folder)).then(
      (kept) => here && setMessages(kept),
      (e) => {
        if (!here) return;
        setMessages([]);
        setError(forUser("读取对话", e));
      },
    );
    return () => {
      here = false;
      stop.current?.abort();
    };
  }, [folder]);

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
      { id: `local-${Date.now()}`, role: "user", content: said, job_id: null, created_at: Date.now() },
    ]);
    const abort = new AbortController();
    stop.current = abort;
    const config = localAiConfig(user.id);
    let answer = "";
    let messageId: string | undefined;
    let jobId: string | null = null;
    try {
      const res = await apiStream(
        ENDPOINT(folder),
        {
          ...(folder && { folder_id: folder }),
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
          if (event.delta) {
            answer += event.delta;
            setAnswering(answer);
          } else if (event.error) {
            setError(event.error);
          } else if (event.done) {
            messageId = event.message_id;
            jobId = event.job_id ?? null;
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
      if (answer || jobId) {
        setMessages((all) => [
          ...(all ?? []),
          {
            id: messageId ?? `local-${Date.now()}`,
            role: "assistant",
            content: answer,
            job_id: jobId,
            created_at: Date.now(),
          },
        ]);
      }
      setAnswering("");
      setBusy(false);
      sending.current = false;
      stop.current = undefined;
    }
  }

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    void say(draft);
  };

  const clear = async () => {
    if (!(await confirm({ title: "清空这段对话？", body: "服务器上的记录一并删除，不能撤销。", ok: "清空", danger: true }))) return;
    try {
      await api("DELETE", ENDPOINT(folder));
      setMessages([]);
      setError("");
      snack("已清空对话");
    } catch (e) {
      snack(forUser("清空对话", e));
    }
  };

  const yours = (messages ?? []).some((m) => m.role === "user");
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
            <button type="button" className="text-btn" onClick={clear} disabled={!yours || busy}>
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
            {messages.map((m) => (
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
    </Modal>
  );
}
