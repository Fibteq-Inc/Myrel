import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/clis";
import { downloadSkills } from "../src/skills";

const b64 = (t: string) => Buffer.from(t).toString("base64");

describe("skills", () => {
  it("downloads a turn's skills as a Claude Code plugin, never outside their folders", async () => {
    const bundle = {
      skills: [
        { name: "pdf-forms", files: [{ path: "SKILL.md", content: b64("---\nname: pdf-forms\n---\n") }, { path: "scripts/fill.py", content: b64("print(1)") }] },
        { name: "Bad Name", files: [{ path: "SKILL.md", content: b64("x") }] },
        { name: "evil", files: [{ path: "../../../escape.txt", content: b64("x") }] },
      ],
    };
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(bundle));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const dir = mkdtempSync(join(tmpdir(), "myrel-agent-"));
    try {
      const got = await downloadSkills(`http://127.0.0.1:${port}/api/agent-mcp/thr_x/skills`, "tok", dir);
      expect(seen).toEqual(["Bearer tok"]);
      expect(got).toMatchObject({ plugin: join(dir, "plugin"), skills: join(dir, "plugin", "skills"), count: 2 });
      expect(readFileSync(join(dir, "plugin", "skills", "pdf-forms", "SKILL.md"), "utf8")).toContain("pdf-forms");
      expect(statSync(join(dir, "plugin", "skills", "pdf-forms", "scripts", "fill.py")).mode & 0o111).not.toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "plugin", ".claude-plugin", "plugin.json"), "utf8")).name).toBe("myrel");
      expect(existsSync(join(dir, "plugin", "skills", "Bad Name"))).toBe(false);
      expect(existsSync(join(dir, "escape.txt"))).toBe(false);
      expect(existsSync(join(dir, "plugin", "escape.txt"))).toBe(false);
    } finally {
      server.close();
    }
    expect(await downloadSkills("http://127.0.0.1:1/nothing", "tok", dir)).toBeNull();
  });

  it("hands the skills to Claude Code as a plugin and lets Gemini CLI read them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myrel-agent-"));
    const skills = { plugin: "/tmp/p", dir: "/tmp/p/skills" };
    const claude = await ADAPTERS.claude.agent({ url: "https://m.test/api/agent-mcp/t", token: "t", dir, skills });
    expect(claude.args.join(" ")).toContain("--plugin-dir /tmp/p --add-dir /tmp/p/skills");
    const gemini = await ADAPTERS.gemini.agent({ url: "https://m.test/api/agent-mcp/t", token: "t", dir, skills });
    expect(gemini.args).toEqual(["--include-directories", "/tmp/p/skills"]);
    expect((await ADAPTERS.claude.agent({ url: "https://m.test/api/agent-mcp/t", token: "t", dir })).args).not.toContain("--plugin-dir");
  });
});
