import { describe, expect, it } from "vitest";
import { ClientEvent, cliLogins, OWN_ACCOUNT, ProjectSettings, resolveAccount, Thread } from "../src";

const limits = (used: number) => ({ windows: [{ kind: "session", usedPercent: used, resetsAt: null }], at: "2026-11-02T10:00:00.000Z" });

describe("a CLI's logins", () => {
  it("are its own first, named only when it has others, each with its own limits", () => {
    expect(cliLogins({ limits: limits(80) })).toEqual([{ account: null, name: null, limits: limits(80) }]);
    expect(cliLogins({ limits: limits(80), defaultAccount: "Personal", accounts: [{ id: "work", name: "Work", limits: limits(10) }, { id: "side", name: "Side" }] })).toEqual([
      { account: null, name: "Personal", limits: limits(80) },
      { account: "work", name: "Work", limits: limits(10) },
      { account: "side", name: "Side" },
    ]);
  });

  it("resolve to the thread's pick, else the project's, when the computer has it", () => {
    const installed = { accounts: [{ id: "work", name: "Work" }] };
    expect(resolveAccount({ thread: "work", project: null }, installed)).toEqual({ account: "work" });
    expect(resolveAccount({ thread: null, project: "work" }, installed)).toEqual({ account: "work" });
    // The thread's pick of the CLI's own login wins over the project's default.
    expect(resolveAccount({ thread: OWN_ACCOUNT, project: "work" }, installed)).toEqual({});
    expect(resolveAccount({ thread: null, project: null }, installed)).toEqual({});
    // One the computer no longer has (or a runner too old to list any): the CLI's own, and why.
    expect(resolveAccount({ thread: "gone" }, installed)).toEqual({ missing: "gone" });
    expect(resolveAccount({ project: "work" }, { })).toEqual({ missing: "work" });
  });

  it("keep older servers' threads, settings and events readable", () => {
    const threadId = "thr_01JTEST0000000000000000000";
    expect(Thread.shape.cli.parse({ id: "claude", options: ["claude"], by: "person", reason: null })).toEqual({ id: "claude", options: ["claude"], by: "person", reason: null });
    expect(ProjectSettings.shape.cliModels.parse({ claude: { model: null, effort: null } })).toEqual({ claude: { model: null, effort: null } });
    expect(ClientEvent.parse({ type: "thread.cli", threadId, cli: "claude", account: "work" })).toMatchObject({ account: "work" });
    expect(ClientEvent.safeParse({ type: "thread.cli", threadId, cli: "claude", account: "Not An Id" }).success).toBe(false);
  });
});
