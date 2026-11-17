// What a chat was asked, as a tidying's request: the user's last word decides, and the turns
// before it say what he means. See docs/ai.md#对话.

import type { AiMessage } from "../api/types/AiMessage";

const HEAD = "以下是用户和 AI 助手的对话，按用户最后的要求整理，前面的对话只用来理解他的意思：\n\n";
/** As many characters as a job's text may have. */
const ROOM = 10_000 - [...HEAD].length;

export function transcript(messages: AiMessage[]): string {
  const body = messages.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.trim()}`).join("\n\n");
  const chars = [...body];
  // The end says what is wanted now; the start goes first when it does not fit.
  return HEAD + (chars.length > ROOM ? `…${chars.slice(chars.length - ROOM + 1).join("")}` : body);
}

/** One event of a chat's answer. */
export type ChatEvent = { delta?: string; done?: true; error?: string };

/** The events of a chat's answer as it is read: a frame may be cut in two by the network. */
export class ChatEvents {
  private buffer = "";

  push(chunk: string): ChatEvent[] {
    this.buffer += chunk;
    const events: ChatEvent[] = [];
    let cut: number;
    while ((cut = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        events.push(JSON.parse(line.slice(6)) as ChatEvent);
      }
    }
    return events;
  }
}
