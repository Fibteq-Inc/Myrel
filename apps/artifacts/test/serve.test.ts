import { artifactObjectKey, createId } from "@altair/protocol";
import { signArtifact } from "@altair/protocol/artifact-signature";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const SECRET = "test-signing-secret";

async function publish(html: string, version = 1) {
  const id = createId("artifact");
  await env.ARTIFACTS.put(artifactObjectKey(id, version), html);
  return id;
}

async function signed(id: string, version: number, exp = Date.now() + 60_000, secret = SECRET) {
  const sig = await signArtifact(secret, id, version, exp);
  return `https://usercontent.test/${id}/v${version}/?exp=${exp}&sig=${sig}`;
}

const get = (url: string, init?: RequestInit) => exports.default.fetch(new Request(url, init));

describe("artifact Worker", () => {
  it("serves a signed version with a strict, sandboxing CSP", async () => {
    const id = await publish("<h1>Hello</h1>");
    const res = await get(await signed(id, 1));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Hello</h1>");
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors https://altair.test tauri://localhost");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuses unsigned, tampered, expired or wrongly signed links", async () => {
    const id = await publish("<p>secret</p>");
    expect((await get(`https://usercontent.test/${id}/v1/`)).status).toBe(403);
    expect((await get((await signed(id, 1)).replace(/sig=./, "sig=A"))).status).toBe(403);
    expect((await get(await signed(id, 1, Date.now() - 1))).status).toBe(403);
    expect((await get(await signed(id, 1, undefined, "wrong"))).status).toBe(403);
    // A signature for v1 does not open v2.
    expect((await get((await signed(id, 1)).replace("/v1/", "/v2/"))).status).toBe(403);
  });

  it("404s for a version that does not exist and for unknown paths", async () => {
    const id = createId("artifact");
    expect((await get(await signed(id, 1))).status).toBe(404);
    expect((await get("https://usercontent.test/whatever")).status).toBe(404);
  });

  it("only answers GET and HEAD", async () => {
    const id = await publish("<p>x</p>");
    expect((await get(await signed(id, 1), { method: "POST" })).status).toBe(405);
    const head = await get(await signed(id, 1), { method: "HEAD" });
    expect(head.status).toBe(200);
  });
});
