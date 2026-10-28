import { describe, expect, it } from "vitest";
import { answeredSshMessage, sshAnswer, sshMessage } from "../src/agents/ssh-access";
import { maskSecrets, matchSshHost, type SshHostRow } from "../src/ssh/store";

const row = (alias: string, host: string, user = "deploy") => ({ alias, host, user, port: 22 }) as SshHostRow;

describe("SSH servers", () => {
  it("finds a server by its name or its address", () => {
    const rows = [row("prod-web", "203.0.113.10"), row("db", "10.0.4.7", "myrel")];
    expect(matchSshHost(rows, "prod-web")?.alias).toBe("prod-web");
    expect(matchSshHost(rows, "deploy@203.0.113.10")?.alias).toBe("prod-web");
    expect(matchSshHost(rows, "myrel@db:2222")?.alias).toBe("db");
    expect(matchSshHost(rows, "root@prod-web")).toBeNull();
    expect(matchSshHost(rows, "evil.example.com")).toBeNull();
  });

  it("masks secrets before output is kept", () => {
    const out = maskSecrets("DB_PASSWORD=hunter2\nok\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(out).toBe("DB_PASSWORD=[secret]\nok\n[private key]\n[secret]");
  });
});

describe("SSH cards", () => {
  const card = { alias: "prod-web", user: "deploy", host: "203.0.113.10", port: 22, computer: "vmi3311634", hostFingerprint: "SHA256:abc", command: "uptime", reason: "load", danger: false };

  it("shows where, which server key, the whole command and why", () => {
    const body = sshMessage(card, "tr");
    for (const part of ["vmi3311634", "`deploy@203.0.113.10:22`", "SHA256:abc", "```sh\nuptime\n```", "Neden: load", "Bu çalışmada bu sunucuya izin ver"]) expect(body).toContain(part);
    expect(answeredSshMessage(card, "tr").startsWith("SSH prod-web: `uptime`")).toBe(true);
  });

  it("offers no turn-wide allow for a destructive command", () => {
    const body = sshMessage({ ...card, command: "rm -rf /", danger: true }, "en");
    expect(body).toContain('"danger": true');
    expect(body).not.toContain("Allow this server this turn");
    expect(sshAnswer("Bu çalışmada bu sunucuya izin ver", true)).toBeNull();
    expect(sshAnswer("Yine de çalıştır", true)).toBe("once");
    expect(sshAnswer("Bu çalışmada bu sunucuya izin ver", false)).toBe("always");
    expect(sshAnswer("Don't run", false)).toBe("deny");
  });
});
