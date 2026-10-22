import { describe, expect, it } from "vitest";
import { relayLine } from "../src/agents/relay-line";

describe("relayLine", () => {
  it("speaks the note's language", () => {
    expect(relayLine("brief", "Hesap makinesini yap ve çalıştığını göster.")).toBe("Koordinatör görev tanımını iletti.");
    expect(relayLine("follow_up", "Make it orange.")).toBe("The coordinator forwarded a follow-up.");
    expect(relayLine("relay", "Plan limitlerine MCP bağlayıcılarını da say.", "MCP")).toBe('"MCP" thread\'inden bir not geldi.');
  });
});
