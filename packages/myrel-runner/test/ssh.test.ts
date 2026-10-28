import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgetKey, fingerprint, hostKeyAlias, type Keychain, listKeys, makeKey, parseKeyscan, setKnownHost, sshArgs, sshEnv, sshError } from "../src/ssh";
import { installShim, parseSsh, runShim, SHIM_VAR } from "../src/ssh-shim";

const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const ref = { projectId: "proj_01HZY3M4K5N6P7Q8R9S0T1V2W3", alias: "prod-web" };
const target = { ...ref, host: "203.0.113.10", port: 2222, user: "deploy", hostKey: ED };

let home: string;
const before = process.env.MYREL_RUNNER_HOME;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-ssh-"));
  process.env.MYREL_RUNNER_HOME = join(home, ".myrel-runner");
});
afterAll(async () => {
  if (before === undefined) delete process.env.MYREL_RUNNER_HOME;
  else process.env.MYREL_RUNNER_HOME = before;
  await rm(home, { recursive: true, force: true });
});

describe("parseSsh", () => {
  it("turns `ssh host command` into one call", () => {
    expect(parseSsh(["prod-web", "uptime"])).toEqual({ kind: "run", host: "prod-web", command: "uptime" });
    expect(parseSsh(["-p", "22", "-T", "deploy@prod-web", "journalctl", "-u", "nginx"])).toEqual({ kind: "run", host: "deploy@prod-web", command: "journalctl -u nginx" });
    expect(parseSsh(["-l", "deploy", "-oBatchMode=yes", "prod-web", "--", "ls"])).toEqual({ kind: "run", host: "deploy@prod-web", command: "-- ls" });
  });

  it("refuses sessions, forwarding and options that change the connection", () => {
    for (const args of [["prod-web"], ["-t", "prod-web", "top"], ["-L", "8080:localhost:80", "prod-web", "x"], ["-A", "prod-web", "x"], ["-o", "ProxyCommand=nc x", "prod-web", "x"], ["-i", "/tmp/k", "prod-web", "x"], ["-F", "/tmp/c", "prod-web", "x"]]) {
      expect(parseSsh(args).kind).toBe("refuse");
    }
    expect(parseSsh(["prod-web", "rsync", "--server", "-e.LsfxC", "."])).toMatchObject({ kind: "refuse", message: expect.stringContaining("Copying files") });
  });

  it("leaves git's own SSH alone", () => {
    expect(parseSsh(["-o", "SendEnv=GIT_PROTOCOL", "git@github.com", "git-upload-pack 'a/b.git'"])).toEqual({ kind: "passthrough" });
    expect(parseSsh(["git@github.com", "git-upload-pack 'a/b.git'"])).toEqual({ kind: "passthrough" });
    expect(parseSsh(["evil", "git-upload-pack 'a'; rm -rf ~"]).kind).toBe("run");
  });
});

describe("server keys", () => {
  it("computes fingerprints as ssh-keygen -l does", () => {
    expect(fingerprint(ED)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprint(`${ED} someone@host`)).toBe(fingerprint(ED));
  });

  it("reads ssh-keyscan's output, ed25519 first", () => {
    const keys = parseKeyscan(`# 203.0.113.10:22 SSH-2.0-OpenSSH_9.6\n[203.0.113.10]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n[203.0.113.10]:2222 ${ED}\n`);
    expect(keys.map((k) => k.type)).toEqual(["ssh-ed25519", "ssh-rsa"]);
    expect(keys[0]!.key).toBe(ED);
  });

  it("keeps one confirmed key per server and refuses another", async () => {
    await setKnownHost(ref, ED, false);
    await setKnownHost(ref, ED, false);
    const file = join(process.env.MYREL_RUNNER_HOME!, "ssh", "known_hosts");
    expect((await readFile(file, "utf8")).trim()).toBe(`${hostKeyAlias(ref)} ${ED}`);
    await expect(setKnownHost(ref, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE", false)).rejects.toThrow(/not the one confirmed/);
    await setKnownHost(ref, null);
    expect((await readFile(file, "utf8")).trim()).toBe("");
  });

  it("tells why ssh failed", () => {
    expect(sshError("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@")).toBe("hostkey");
    expect(sshError("deploy@203.0.113.10: Permission denied (publickey).")).toBe("auth");
    expect(sshError("ssh: connect to host 203.0.113.10 port 22: Connection refused")).toBe("connect");
  });
});

describe("ssh's options", () => {
  it("use only Myrel's key, its known_hosts and none of the person's settings", () => {
    const args = sshArgs(target, "/k", { passphrase: false, timeoutSec: 15 });
    expect(args.slice(0, 2)).toEqual(["-F", "none"]);
    for (const o of ["BatchMode=yes", "IdentitiesOnly=yes", "IdentityAgent=none", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes", `HostKeyAlias=${hostKeyAlias(ref)}`]) {
      expect(args).toContain(o);
    }
    expect(args.slice(-8)).toEqual(["-i", "/k", "-p", "2222", "-l", "deploy", "--", "203.0.113.10"]);
  });

  it("leave the person's ssh-agent out", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    expect(sshEnv().SSH_AUTH_SOCK).toBeUndefined();
    delete process.env.SSH_AUTH_SOCK;
  });
});

describe("keys", () => {
  const memory = (): Keychain & { saved: Map<string, string> } => {
    const saved = new Map<string, string>();
    return { saved, set: async (a, s) => void saved.set(a, s), get: async (a) => saved.get(a) ?? null, remove: async (a) => void saved.delete(a) };
  };

  it("makes an ed25519 key with its passphrase in the keychain, readable by the owner only", async () => {
    const keychain = memory();
    const key = await makeKey(ref, "myrel:test:prod-web", undefined, keychain);
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ myrel:test:prod-web$/);
    expect(key.fingerprint).toBe(fingerprint(key.publicKey));
    expect(key.protected).toBe(true);
    expect(keychain.saved.get(`${ref.projectId}/${ref.alias}`)).toBeTruthy();
    const file = join(process.env.MYREL_RUNNER_HOME!, "ssh", ref.projectId, ref.alias);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await forgetKey(ref, keychain);
    await expect(stat(file)).rejects.toThrow();
    expect(keychain.saved.size).toBe(0);
  });

  it("makes a key without a passphrase where there is no keychain", async () => {
    const key = await makeKey(ref, "c", undefined, null);
    expect(key.protected).toBe(false);
    await forgetKey(ref, null);
  });

  it("lists ~/.ssh by name and fingerprint, and only takes keys from there", async () => {
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(join(home, ".ssh", "id_ed25519"), "secret");
    await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${ED} me@laptop\n`);
    await writeFile(join(home, ".ssh", "lonely.pub"), `${ED}\n`);
    expect(await listKeys(home)).toEqual([{ path: join(home, ".ssh", "id_ed25519"), name: "id_ed25519", type: "ssh-ed25519", fingerprint: fingerprint(ED), comment: "me@laptop" }]);
    await expect(makeKey(ref, "c", "/etc/passwd", null)).rejects.toThrow(/Only keys in ~\/.ssh/);
  });
});

describe("the shim", () => {
  let server: Server;
  let url: string;
  const calls: unknown[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        const text = JSON.stringify({ exit_code: 3, stdout: "up 3 days\n", stderr: "warn\n" });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-mcp/thr_x`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("asks Myrel's ssh_run and hands back its output and exit code", async () => {
    const run = join(home, "run");
    const env = await installShim(run, { url, token: "turn-token-0123456789" }, "linux");
    expect(env.PATH!.split(":")[0]).toBe(join(run, "ssh-bin"));
    expect((await stat(join(run, "ssh-bin", "ssh"))).mode & 0o111).toBeTruthy();
    expect((await stat(env[SHIM_VAR]!)).mode & 0o777).toBe(0o600);
    process.env[SHIM_VAR] = env[SHIM_VAR];
    let out = "";
    let err = "";
    const code = await runShim("ssh", ["prod-web", "uptime"], { out: { write: (s: string) => (out += s) }, err: { write: (s: string) => (err += s) } } as never);
    delete process.env[SHIM_VAR];
    expect(code).toBe(3);
    expect(out).toBe("up 3 days\n");
    expect(err).toBe("warn\n");
    expect(calls).toEqual([
      { auth: "Bearer turn-token-0123456789", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ssh_run", arguments: { host: "prod-web", command: "uptime", reason: "Asked from the shell (ssh)." } } } },
    ]);
  });

  it("refuses scp and sftp", async () => {
    let err = "";
    expect(await runShim("scp", ["a", "prod-web:/tmp"], { out: { write: () => true }, err: { write: (s: string) => (err += s) } } as never)).toBe(255);
    expect(err).toMatch(/Copying files/);
  });
});
