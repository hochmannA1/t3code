import { describe, expect, it } from "vite-plus/test";
import { redactMemoryText } from "./redactMemoryText.ts";

describe("memory credential redaction", () => {
  it("redacts multiline keys, authorization headers, and assigned credentials", () => {
    const source =
      "-----BEGIN PRIVATE KEY-----\nsecret key material\n-----END PRIVATE KEY-----\nAuthorization: Bearer abc.def.secret\npassword='private value'\nAPI_KEY=sk-abcdefghijklmnopqrstuv";
    const redacted = redactMemoryText(source);
    expect(redacted).not.toContain("secret key material");
    expect(redacted).not.toContain("abc.def.secret");
    expect(redacted).not.toContain("private value");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuv");
  });
  it("preserves useful authentication procedure descriptions", () => {
    const source =
      "Use the configured Azure provider. Never commit API keys. Verify authentication with the CLI.";
    expect(redactMemoryText(source)).toBe(source);
  });
});
