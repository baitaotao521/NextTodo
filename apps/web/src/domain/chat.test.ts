import { describe, expect, it } from "vitest";
import { ChatEvents } from "./chat";

describe("a chat's answer read as it comes", () => {
  it("reads events split across reads, and keeps the rest of a frame", () => {
    const events = new ChatEvents();
    expect(events.push('data: {"delta":"你')).toEqual([]);
    expect(events.push('好"}\n\ndata: {"chat_id":"c1"}\n')).toEqual([{ delta: "你好" }]);
    expect(events.push('\ndata: {"delta":"呀"}\n\ndata: {"done":true,"message_id":"m1","chat_id":"c1","job_id":"j1","ask":{"question":"选哪个？","options":["甲","乙"],"recommended":1}}\n\n')).toEqual([
      { chat_id: "c1" },
      { delta: "呀" },
      { done: true, message_id: "m1", chat_id: "c1", job_id: "j1", ask: { question: "选哪个？", options: ["甲", "乙"], recommended: 1 } },
    ]);
  });

  it("passes an error on, and ignores keep-alive comments", () => {
    const events = new ChatEvents();
    expect(events.push(': keep-alive\n\ndata: {"error":"余额不足"}\n\n')).toEqual([{ error: "余额不足" }]);
  });
});
