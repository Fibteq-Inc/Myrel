import { CLOUD_RUNNER, type Project } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkTaskEnv } from "../src/keys";
import { api, until } from "./fake-agent";

describe("a visual check in the cloud", () => {
  it("runs with CHECK_MODEL when the server sets one, else like any cloud turn", () => {
    const base = { RUNNER_MODEL: "auto", RUNNER_IMAGES: "" };
    expect(checkTaskEnv({ ...base, CHECK_MODEL: "vision-1", CHECK_IMAGES: "true" })).toMatchObject({ RUNNER_MODEL: "vision-1", RUNNER_IMAGES: "true" });
    expect(checkTaskEnv({ ...base, CHECK_MODEL: "", CHECK_IMAGES: "true" })).toMatchObject({ RUNNER_MODEL: "auto", RUNNER_IMAGES: "" });
  });

  it("opens its evaluator thread in the cloud with the check model, which reads images", { timeout: 30_000 }, async () => {
    const email = `u${crypto.randomUUID()}@example.com`;
    const signUp = await api("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, password: "correct-horse-battery", name: "İsmail" }) });
    const token = signUp.headers.get("set-auth-token")!;
    const { project } = (await (await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Myrel" }) })).json()) as { project: Project };
    // Opening the project from a client is how the server learns its own address for the sandbox.
    const ws = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } })).webSocket!;
    ws.accept();
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token, body: JSON.stringify({ visualCheck: true }) });
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "Fiyat sayfası" });
    const coder = await projectAgent.createThread(root.id, "Fiyat sayfası");

    const evaluator = await projectAgent.startVisualCheck({
      notice: "🔍 Visual check: round 1",
      title: "Visual check 1: Fiyat sayfası",
      brief: "Check the pricing page.",
      cli: { id: "opencode", options: ["opencode"], by: "coordinator", reason: "Visual check: in the cloud, like the work" },
      runner: { id: CLOUD_RUNNER, by: "auto", reason: null },
      model: null,
      actor: null,
      check: { checkId: "chk_cloud", round: 1, coderThreadId: coder.id, folder: "checks/chk_cloud/1", branch: "feat/pricing" },
    });
    expect(evaluator).toMatchObject({ parentId: coder.id, runner: { id: CLOUD_RUNNER } });

    // The test runtime has no container, so the turn fails; what the sandbox was handed is kept.
    const agent = await getAgentByName(env.THREAD_AGENT, evaluator.id);
    await until(async () => ((await agent.getTasks()) as { status: string }[])[0]?.status === "failed", "the evaluator's turn");
    const spec = await runInDurableObject(agent as unknown as DurableObjectStub, (_, state) =>
      JSON.parse(state.storage.sql.exec<{ spec: string }>("SELECT spec FROM tasks").one().spec),
    );
    expect(spec.model).toMatchObject({ provider: "fireworks", id: "accounts/fireworks/models/check-vision", images: true });
    // The built-in skill goes with it.
    expect(spec.skills?.url).toContain("/skills");
    ws.close();
  });
});
