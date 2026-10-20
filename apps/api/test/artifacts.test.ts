import type { Artifact, ArtifactVersion, ArtifactView, Message, Project, Thread } from "@altair/protocol";
import { artifactObjectKey } from "@altair/protocol";
import { verifyArtifact } from "@altair/protocol/artifact-signature";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://altair.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp() {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
  });
  return res.headers.get("set-auth-token")!;
}

async function setup() {
  const token = await signUp();
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Altair" }) });
  const { project } = (await res.json()) as { project: Project };
  const ws = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, {
    headers: { upgrade: "websocket" },
  })).webSocket!;
  ws.accept();
  return { token, project, ws, agent: await getAgentByName(env.PROJECT_AGENT, project.id) };
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 160; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
const isCoordinator = (r: FakeRequest) => r.system.includes("coordinator of a shared project chat");
const newMessageId = (prompt: string) => /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(prompt)?.[1];

afterEach(resetFakeModel);

describe("artifacts", () => {
  it("lets a thread agent publish an artifact, version it and attach it to its reply", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (isCoordinator(req)) {
        const id = newMessageId(req.prompt);
        return id
          ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Report", instructions: "Make a report.", project_ack: "On it." })] }
          : { text: "", toolCalls: [] };
      }
      prompts.push(req.prompt);
      const existing = /\[(art_[0-9A-Z]{26})\] "Sales report" · v1/.exec(req.prompt)?.[1];
      if (existing) {
        return {
          text: "",
          toolCalls: [
            call("publish_artifact", { artifact_id: existing, title: "Sales report", html: "<h1>v2</h1>" }),
            call("reply", { text: "Updated it." }),
          ],
        };
      }
      return {
        text: "",
        toolCalls: [
          call("publish_artifact", { title: "Sales report", description: "Q3 numbers.", html: "<h1>v1</h1>" }),
          call("reply", { text: "Here is the report." }),
        ],
      };
    });

    const { token, project, ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "make me a sales report" }));
    const thread: Thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "thread reply");

    const replies = async () =>
      ((await agent.getThreadContext(thread.id))?.messages ?? []).filter((m: Message) => m.authorId === "thread-agent");
    const [first] = await replies();
    expect(first!.body).toBe("Here is the report.");
    expect(first!.artifacts).toEqual([
      { artifactId: expect.stringMatching(/^art_/), version: 1, title: "Sales report" },
    ]);
    const artifactId = first!.artifacts![0]!.artifactId;
    expect(await (await env.ARTIFACTS.get(artifactObjectKey(artifactId, 1)))!.text()).toBe("<h1>v1</h1>");

    // A follow-up publishes v2 of the same artifact.
    ws.send(JSON.stringify({ type: "message.send", threadId: thread.id, body: "update it" }));
    await until(async () => (await replies()).length === 2, "second reply");
    const second = (await replies())[1]!;
    expect(second.artifacts![0]).toMatchObject({ artifactId, version: 2 });

    // The API lists it with its versions and signs view links for the artifact origin.
    const base = `/api/projects/${project.id}/artifacts`;
    const list = (await (await api(base, { token })).json()) as { artifacts: Artifact[] };
    expect(list.artifacts).toMatchObject([{ id: artifactId, title: "Sales report", description: "Q3 numbers.", version: 2 }]);
    const detail = (await (await api(`${base}/${artifactId}`, { token })).json()) as { versions: ArtifactVersion[] };
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);

    const view = (await (await api(`${base}/${artifactId}/view?version=1`, { token })).json()) as ArtifactView;
    expect(view.version).toBe(1);
    const url = new URL(view.url!);
    expect(url.origin).toBe("https://usercontent.test");
    expect(url.pathname).toBe(`/${artifactId}/v1/`);
    const ok = await verifyArtifact("test-signing-secret", artifactId, 1, Number(url.searchParams.get("exp")), url.searchParams.get("sig")!);
    expect(ok).toBe(true);

    const source = await api(`${base}/${artifactId}/versions/2/source`, { token });
    expect(source.headers.get("content-type")).toContain("text/plain");
    expect(await source.text()).toBe("<h1>v2</h1>");
    expect((await api(`${base}/${artifactId}/versions/3/source`, { token })).status).toBe(404);
    expect((await api(`${base}/${artifactId}/view?version=9`, { token })).status).toBe(404);
    ws.close();
  });

  it("keeps artifacts to project members", async () => {
    const { project } = await setup();
    const stranger = await signUp();
    expect((await api(`/api/projects/${project.id}/artifacts`, { token: stranger })).status).toBe(404);
    expect((await api(`/api/projects/${project.id}/artifacts`)).status).toBe(401);
  });

  it("delivers artifact cards even when the agent never replies, and rejects unknown ids", async () => {
    const results: string[] = [];
    setFakeModel((req) => {
      if (isCoordinator(req)) {
        const id = req.turns === 1 && newMessageId(req.prompt);
        return id
          ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Chart", instructions: "Chart it.", project_ack: "On it." })] }
          : { text: "", toolCalls: [] };
      }
      if (req.turns > 1) {
        results.push(req.prompt);
        return { text: "", toolCalls: [] };
      }
      return {
        text: "",
        toolCalls: [
          call("publish_artifact", { artifact_id: "art_01JZZZZZZZZZZZZZZZZZZZZZZZ", title: "Nope", html: "<p>x</p>" }),
          call("publish_artifact", { title: "Chart", html: "<svg></svg>" }),
        ],
      };
    });
    const { ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "chart it" }));
    const thread: Thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "turn end");
    const messages = (await agent.getThreadContext(thread.id))!.messages.filter((m: Message) => m.authorId === "thread-agent");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: "", artifacts: [{ title: "Chart", version: 1 }] });
    expect(await agent.listArtifacts()).toHaveLength(1);
    ws.close();
  });
});
