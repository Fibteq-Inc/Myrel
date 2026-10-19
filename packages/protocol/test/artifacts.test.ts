import { describe, expect, it } from "vitest";
import { artifactObjectKey, createId, Message } from "../src";
import { signArtifact, verifyArtifact } from "../src/artifact-signature";

describe("artifact signatures", () => {
  const id = createId("artifact");
  const exp = Date.now() + 60_000;

  it("verifies a signature made with the same secret", async () => {
    const sig = await signArtifact("s3cret", id, 2, exp);
    expect(await verifyArtifact("s3cret", id, 2, exp, sig)).toBe(true);
  });

  it("rejects another secret, version, expiry or a garbled signature", async () => {
    const sig = await signArtifact("s3cret", id, 2, exp);
    expect(await verifyArtifact("other", id, 2, exp, sig)).toBe(false);
    expect(await verifyArtifact("s3cret", id, 3, exp, sig)).toBe(false);
    expect(await verifyArtifact("s3cret", id, 2, exp + 1, sig)).toBe(false);
    expect(await verifyArtifact("s3cret", id, 2, exp, "%%%")).toBe(false);
  });

  it("rejects an expired link", async () => {
    const past = Date.now() - 1;
    const sig = await signArtifact("s3cret", id, 1, past);
    expect(await verifyArtifact("s3cret", id, 1, past, sig)).toBe(false);
  });

  it("keys versions apart in R2", () => {
    expect(artifactObjectKey(id, 3)).toBe(`artifacts/${id}/v3/index.html`);
  });
});

describe("message artifacts", () => {
  it("accepts an artifact attachment", () => {
    const m = {
      id: createId("message"),
      projectId: createId("project"),
      threadId: null,
      authorKind: "agent",
      authorId: "agent_thread",
      body: "Here it is.",
      artifacts: [{ artifactId: createId("artifact"), version: 1, title: "Report" }],
      seq: 1,
      createdAt: new Date().toISOString(),
    };
    expect(Message.parse(m).artifacts).toHaveLength(1);
    expect(Message.safeParse({ ...m, artifacts: [{ artifactId: "x", version: 1, title: "" }] }).success).toBe(false);
  });
});
