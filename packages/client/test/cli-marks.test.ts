import type { Message, Thread } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { cliMark, threadCli } from "../src/cli-marks";

describe("cliMark", () => {
  it("gives a CLI its name and logo", () => {
    expect(cliMark("claude")).toMatchObject({ id: "claude", name: "Claude Code" });
    expect(cliMark("claude")?.logo?.length).toBeGreaterThan(0);
  });

  it("reads the cloud harness id as the CLI it is", () => {
    expect(cliMark("claude-code")?.id).toBe("claude");
  });

  it("falls back to the initial for a CLI without a logo", () => {
    expect(cliMark("muse")).toMatchObject({ logo: null, initial: "M" });
  });

  it("is null for anything that is not a CLI", () => {
    expect(cliMark("shell")).toBeNull();
    expect(cliMark(undefined)).toBeNull();
  });
});

describe("threadCli", () => {
  const reply = (harness?: string) => ({ authorKind: "agent", stats: harness ? { harness } : undefined }) as Message;
  const person = { authorKind: "user" } as Message;

  it("prefers the CLI picked for the thread", () => {
    expect(threadCli({ cli: { id: "codex" } } as Thread, [reply("claude")])).toBe("codex");
  });

  it("else takes the CLI of the latest reply", () => {
    expect(threadCli({ cli: null } as Thread, [reply("codex"), reply("claude"), person, reply()])).toBe("claude");
  });

  it("is null when nothing says", () => {
    expect(threadCli({ cli: null } as Thread, [person])).toBeNull();
  });
});
