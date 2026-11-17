import { describe, expect, it } from "vitest";
import type { AiMessage } from "../api/types/AiMessage";
import { ChatEvents, transcript } from "./chat";

const said = (role: AiMessage["role"], content: string): AiMessage => ({ id: content, role, content, created_at: 0 });

describe("a chat as a tidying's request", () => {
  it("keeps both sides in order, and says which is the last word", () => {
    const asked = transcript([said("user", "把第二项改到周五"), said("assistant", "好的，把 #12 改到周五。")]);
    expect(asked.startsWith("以下是用户和 AI 助手的对话")).toBe(true);
    expect(asked).toContain("用户：把第二项改到周五");
    expect(asked).toContain("助手：好的，把 #12 改到周五。");
    expect(asked.indexOf("用户：")).toBeLessThan(asked.indexOf("助手："));
  });

  it("keeps the end when it is too long: what is wanted now", () => {
    const asked = transcript([said("user", "甲".repeat(9_000)), said("assistant", "乙".repeat(2_000))]);
    expect([...asked].length).toBeLessThanOrEqual(10_000);
    expect(asked).toContain("乙".repeat(100));
    expect(asked.startsWith("以下是用户和 AI 助手的对话")).toBe(true);
  });
});

describe("a chat's answer read as it comes", () => {
  it("reads events split across reads, and keeps the rest of a frame", () => {
    const events = new ChatEvents();
    expect(events.push('data: {"delta":"你')).toEqual([]);
    expect(events.push('好"}\n\ndata: {"delta":"呀"}\n')).toEqual([{ delta: "你好" }]);
    expect(events.push('\ndata: {"done":true}\n\n')).toEqual([{ delta: "呀" }, { done: true }]);
  });

  it("passes an error on, and ignores keep-alive comments", () => {
    const events = new ChatEvents();
    expect(events.push(': keep-alive\n\ndata: {"error":"余额不足"}\n\n')).toEqual([{ error: "余额不足" }]);
  });
});
