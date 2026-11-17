// A chat's answer read as it comes. See docs/ai.md#对话.

import type { AiAsk } from "../api/types/AiAsk";

/** One event of a chat's answer: what was written, or how it ended. */
export type ChatEvent = {
  delta?: string;
  done?: true;
  error?: string;
  /** The reply's message on the server, once it is done. */
  message_id?: string;
  /** The conversation it belongs to; sent before the answer too, so a new one can be kept. */
  chat_id?: string;
  /** The tidying its changes wait on, when the turn had any. */
  job_id?: string | null;
  /** The question it asks the user, with the choices it suggests, when it asks one. */
  ask?: AiAsk | null;
};

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
