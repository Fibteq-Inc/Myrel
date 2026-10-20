import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config";
import { listDirs, shareableFolder } from "../src/folders";
import { checkPairing, type RunnerStatus, startRunner } from "../src/runner";
import { launchdPlist, startupScript, systemdUnit } from "../src/service";

describe("listDirs", () => {
  it("lists visible folders only, sorted, with the parent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "myrel-dirs-")));
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "Alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "file.txt"), "x");
    await symlink(join(root, "beta"), join(root, "link"));
    await symlink(join(root, "file.txt"), join(root, "file-link"));

    const listing = await listDirs(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(join(root, ".."));
    expect(listing.dirs.map((d) => d.name)).toEqual(["Alpha", "beta", "link"]);
    expect(listing.dirs[0]!.path).toBe(join(root, "Alpha"));
  });

  it("starts at the home folder and refuses relative paths", async () => {
    expect((await listDirs()).path).toBe(await realpath(homedir()));
    await expect(listDirs("projects")).rejects.toThrow("not a full path");
  });
});

describe("shareableFolder", () => {
  it("returns the real path of a folder", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "myrel-share-")));
    await mkdir(join(root, "app"));
    expect(await shareableFolder(join(root, "app", "..", "app"))).toBe(join(root, "app"));
  });

  it("refuses files, missing folders, the home folder and the root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "myrel-share-")));
    await writeFile(join(root, "file.txt"), "x");
    await expect(shareableFolder(join(root, "file.txt"))).rejects.toThrow("not a folder");
    await expect(shareableFolder(join(root, "nope"))).rejects.toThrow("does not exist");
    await expect(shareableFolder(homedir())).rejects.toThrow("project folder");
    await expect(shareableFolder("/")).rejects.toThrow("project folder");
  });
});

describe("service files", () => {
  const args = ["/usr/local/bin/node", "/Users/a b/.myrel-runner/bin/myrel-runner.mjs", "start"];

  it("launchd: keeps the PATH, escapes values and restarts only after a crash", () => {
    const plist = launchdPlist(args, { PATH: "/opt/homebrew/bin:/usr/bin" }, "/tmp/r&r.log");
    expect(plist).toContain("<string>/Users/a b/.myrel-runner/bin/myrel-runner.mjs</string>");
    expect(plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).toContain("<string>/tmp/r&amp;r.log</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  });

  it("systemd: quotes arguments and environment", () => {
    const unit = systemdUnit(args, { PATH: "/usr/bin:/home/a/100%" });
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/Users/a b/.myrel-runner/bin/myrel-runner.mjs" "start"');
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/a/100%%"');
    expect(unit).toContain("Restart=on-failure");
  });

  it("windows: runs hidden with output in the log", () => {
    const vbs = startupScript(["C:\\node\\node.exe", "C:\\Users\\a\\bin\\r.mjs", "start"], "C:\\Users\\a\\runner.log");
    expect(vbs).toContain('""C:\\node\\node.exe"" ""C:\\Users\\a\\bin\\r.mjs"" ""start"" >> ""C:\\Users\\a\\runner.log"" 2>&1""", 0, False');
  });
});

describe("an unpaired computer", () => {
  it("is told apart from an unreachable server, and the runner stops instead of retrying", async () => {
    process.env.MYREL_RUNNER_HOME = await mkdtemp(join(tmpdir(), "myrel-unpaired-"));
    // Answers 401 to everything, the WebSocket upgrade included, like a server that removed this computer.
    const server = createServer((_req, res) => res.writeHead(401).end());
    server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await checkPairing({ server: url, token: "art_old" })).toBe("invalid");
      expect(await checkPairing({ server: "http://127.0.0.1:9", token: "art_old" })).toBe("unknown");

      await saveConfig({ server: url, token: "art_old", folders: [], access: "edit" });
      const statuses: RunnerStatus[] = [];
      const lines: string[] = [];
      const runner = await startRunner({ log: (l) => lines.push(l), onStatus: (s) => statuses.push(s) });
      await runner.done;
      expect(statuses.at(-1)).toEqual({ state: "stopped", reason: "revoked" });
      expect(lines.join("\n")).toContain("not paired with Myrel any more");
    } finally {
      server.close();
    }
  });
});
