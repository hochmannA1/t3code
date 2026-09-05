import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { withChatWorkspaceContext } from "./ChatWorkspaceContext.ts";

const chatProject = { title: "my-chat", workspaceRoot: "/tmp/chats/2026-09-05/my-chat" };

describe("chat workspace context", () => {
  it("keeps the user's prompt intact when the context would exceed the provider limit", () => {
    const prompt = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(withChatWorkspaceContext(prompt, chatProject)).toBe(prompt);
  });

  it("includes the complete context when it fits exactly", () => {
    const overhead = withChatWorkspaceContext("x", chatProject).length - 1;
    const prompt = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - overhead);
    const result = withChatWorkspaceContext(prompt, chatProject);
    expect(result.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(result.startsWith(prompt)).toBe(true);
    expect(result.endsWith("</t3-chat-workspace>")).toBe(true);
  });
});
