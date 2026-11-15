import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findBinaries, sandboxed, sandboxNote, sandboxProblem, sandboxProfile, sandboxState } from "../src/sandbox";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "myrel-sandbox-"));
});

async function exe(path: string, body = "#!/bin/sh\n") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/** Muse Code's launcher beside its binary, and Codex's standalone install linked from a bin folder. */
async function installClis() {
  const bin = join(root, "bin");
  await exe(join(bin, "muse"));
  await exe(join(bin, "muse-bin-1.4.14-R7309.1"));
  const release = join(root, "codex", "releases", "0.166.0-x86_64-unknown-linux-musl");
  await exe(join(release, "bin", "codex"));
  await exe(join(release, "codex-resources", "bwrap"));
  await symlink(join(release, "bin", "codex"), join(bin, "codex"));
  return { env: { PATH: bin }, bin, release };
}

async function restriction(value: string) {
  const file = join(root, "restrict");
  await writeFile(file, `${value}\n`);
  return file;
}

describe("CLIs that bring their own bubblewrap", () => {
  it("finds Muse Code's binary and Codex's bwrap, with patterns that survive updates", async () => {
    const { env, bin } = await installClis();
    const found = await findBinaries(env);
    expect(found).toEqual([
      { cli: "muse", path: join(bin, "muse-bin-1.4.14-R7309.1"), attach: `${bin}/muse-bin-*` },
      {
        cli: "codex",
        path: join(root, "codex", "releases", "0.166.0-x86_64-unknown-linux-musl", "codex-resources", "bwrap"),
        attach: `${join(root, "codex", "releases")}/*/codex-resources/bwrap`,
      },
    ]);
  });

  it("finds nothing for a Codex without its own bwrap (an npm install) or no CLIs at all", async () => {
    await exe(join(root, "bin", "codex"));
    expect(await findBinaries({ PATH: join(root, "bin") })).toEqual([]);
    expect(await findBinaries({ PATH: join(root, "nothing") })).toEqual([]);
  });
});

describe("sandbox state", () => {
  it("is blocked while the restriction is on and no profile covers the CLIs", async () => {
    const { env } = await installClis();
    const s = await sandboxState({ platform: "linux", restrict: await restriction("1"), profileDir: root, user: "dev", env });
    expect(s.applies).toBe(true);
    expect(s.restricted).toBe(true);
    expect(s.blocked.map((b) => b.cli)).toEqual(["muse", "codex"]);
    expect(s.file).toBe(join(root, "myrel-runner-dev"));
    expect(sandboxProblem(s)).toContain("Muse Code and Codex");
    expect(await sandboxNote("muse", s)).toContain("npx myrel-runner sandbox fix");
    expect(await sandboxNote("claude", s)).toBeNull();
  });

  it("is fine once the profile it writes is installed", async () => {
    const { env } = await installClis();
    const binaries = await findBinaries(env);
    await writeFile(join(root, "myrel-runner-dev"), sandboxProfile(binaries, "dev"));
    const s = await sandboxState({ platform: "linux", restrict: await restriction("1"), profileDir: root, user: "dev", env });
    expect(s.blocked).toEqual([]);
    expect(sandboxProblem(s)).toBeNull();
    expect(await sandboxNote("codex", s)).toBeNull();
  });

  it("needs nothing with the restriction off, without AppArmor, or off Linux", async () => {
    const { env } = await installClis();
    const off = await sandboxState({ platform: "linux", restrict: await restriction("0"), profileDir: root, env });
    expect(off.applies).toBe(true);
    expect(sandboxProblem(off)).toBeNull();
    const none = await sandboxState({ platform: "linux", restrict: join(root, "missing"), profileDir: root, env });
    expect(none.applies).toBe(false);
    const mac = await sandboxState({ platform: "darwin", restrict: await restriction("1"), profileDir: root, env });
    expect(mac).toMatchObject({ applies: false, binaries: [] });
  });
});

describe("the AppArmor profile", () => {
  it("gives each binary user namespaces and nothing else, under per-user names", () => {
    const profile = sandboxProfile([{ cli: "muse", path: "/home/a b/.local/bin/muse-bin-1", attach: "/home/a b/.local/bin/muse-bin-*" }], "ana");
    expect(profile).toContain("abi <abi/4.0>,");
    expect(profile).toContain('profile myrel-runner-ana-muse "/home/a b/.local/bin/muse-bin-*" flags=(unconfined) {\n  userns,\n');
  });

  it("escapes glob characters in the folder part", async () => {
    const bin = join(root, "we[ird]");
    await exe(join(bin, "muse"));
    await exe(join(bin, "muse-bin-2"));
    const [muse] = await findBinaries({ PATH: bin });
    expect(muse!.attach).toBe(`${root}/we\\[ird\\]/muse-bin-*`);
  });
});

describe("which runs use the CLI's own sandbox", () => {
  it("is Codex below full and Muse Code at edit and auto", () => {
    expect(["read", "edit", "auto", "full"].map((a) => sandboxed("codex", a as "read"))).toEqual([true, true, true, false]);
    expect(["read", "edit", "auto", "full"].map((a) => sandboxed("muse", a as "read"))).toEqual([false, true, true, false]);
    expect(sandboxed("claude", "edit")).toBe(false);
  });
});
