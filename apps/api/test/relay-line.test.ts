import { describe, expect, it } from "vitest";
import { answerLine, relayLine } from "../src/agents/relay-line";

describe("relayLine", () => {
  it("speaks the note's language", () => {
    expect(relayLine("brief", "Hesap makinesini yap ve çalıştığını göster.")).toBe("Koordinatör görev tanımını iletti.");
    expect(relayLine("follow_up", "Make it orange.")).toBe("The coordinator forwarded a follow-up.");
    expect(relayLine("relay", "Plan limitlerine MCP bağlayıcılarını da say.", "MCP")).toBe('"MCP" thread\'inden bir not geldi.');
  });

  it("keeps the coordinator's answer and its source in sight", () => {
    expect(answerLine("PR aç", "proje talimatı", "Open a PR?")).toBe("Koordinatör ajanın sorusunu cevapladı: **PR aç** (kaynak: proje talimatı)");
    expect(answerLine("Yes", "memory: release-flow", "Tag the release?")).toBe(
      "The coordinator answered the agent's question: **Yes** (source: memory: release-flow)",
    );
  });
});
