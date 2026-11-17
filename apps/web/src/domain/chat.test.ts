import { describe, expect, it } from "vitest";
import { ChatEvents } from "./chat";

describe("a chat's answer read as it comes", () => {
  it("reads events split across reads, and keeps the rest of a frame", () => {
    const events = new ChatEvents();
    expect(events.push('data: {"delta":"你')).toEqual([]);
    expect(events.push('好"}\n\ndata: {"delta":"呀"}\n')).toEqual([{ delta: "你好" }]);
    expect(events.push('\ndata: {"done":true,"message_id":"m1","job_id":"j1"}\n\n')).toEqual([
      { delta: "呀" },
      { done: true, message_id: "m1", job_id: "j1" },
    ]);
  });

  it("passes an error on, and ignores keep-alive comments", () => {
    const events = new ChatEvents();
    expect(events.push(': keep-alive\n\ndata: {"error":"余额不足"}\n\n')).toEqual([{ error: "余额不足" }]);
  });
});
