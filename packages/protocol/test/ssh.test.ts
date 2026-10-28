import { describe, expect, it } from "vitest";
import { authorizedKeysCommand, CreateSshHostInput, Decision, destructiveCommand, ServerToRunner } from "../src";

describe("destructiveCommand", () => {
  it("flags commands that delete, stop or overwrite", () => {
    for (const c of ["rm -rf /var/cache/app", "sudo reboot", "systemctl stop nginx", "docker compose down", "psql -c 'DROP TABLE users'", "kill -9 123", "echo x > /etc/hosts", "cd /tmp && rm a"]) {
      expect(destructiveCommand(c), c).toBe(true);
    }
  });

  it("leaves reading alone", () => {
    for (const c of ["uptime", "df -h", "journalctl -u nginx -n 200 --no-pager", "systemctl status nginx", "cat /etc/hosts", "ls -la /var/www", "grep -r format ."]) {
      expect(destructiveCommand(c), c).toBe(false);
    }
  });
});

describe("SSH settings", () => {
  it("takes names agents can type and no option-like user", () => {
    expect(CreateSshHostInput.safeParse({ runnerId: "r", alias: "prod-web", host: "203.0.113.10", user: "deploy" }).success).toBe(true);
    expect(CreateSshHostInput.safeParse({ runnerId: "r", alias: "Prod Web", host: "x", user: "deploy" }).success).toBe(false);
    expect(CreateSshHostInput.safeParse({ runnerId: "r", alias: "p", host: "-oProxyCommand=x", user: "deploy" }).success).toBe(false);
    expect(CreateSshHostInput.safeParse({ runnerId: "r", alias: "p", host: "x", user: "-l" }).success).toBe(false);
  });

  it("restricts the key on the server", () => {
    expect(authorizedKeysCommand("ssh-ed25519 AAAA myrel:p:prod-web")).toContain("echo 'restrict ssh-ed25519 AAAA myrel:p:prod-web' >> ~/.ssh/authorized_keys");
  });

  it("marks destructive cards, which older clients read as plain ones", () => {
    const card = { question: "q", options: [{ label: "a" }, { label: "b" }], danger: true };
    expect(Decision.parse(card).danger).toBe(true);
  });

  it("carries a command to the runner", () => {
    const target = { projectId: "proj_01HZY3M4K5N6P7Q8R9S0T1V2W3", alias: "prod-web", host: "203.0.113.10", port: 22, user: "deploy", hostKey: "ssh-ed25519 AAAA" };
    expect(ServerToRunner.safeParse({ type: "ssh.run", requestId: "r1", target, command: "uptime" }).success).toBe(true);
    expect(ServerToRunner.safeParse({ type: "ssh.run", requestId: "r1", target: { ...target, user: "-oProxyCommand=x" }, command: "uptime" }).success).toBe(false);
  });
});
