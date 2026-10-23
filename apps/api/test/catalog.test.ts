import type { CatalogPage } from "@myrel/protocol";
import { env as testEnv } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { catalogRow, catalogSize, cleanTitle, syncCatalog, titleFromName } from "../src/connectors/catalog";

const BASE = "http://myrel.test";
const env = testEnv as unknown as Env;

const meta = (updatedAt: string, status = "active") => ({
  "io.modelcontextprotocol.registry/official": { status, updatedAt, isLatest: true },
});
const entry = (name: string, server: Record<string, unknown>, updatedAt = "2026-10-01T00:00:00Z", status = "active") => ({
  server: { name, version: "1.0.0", ...server },
  _meta: meta(updatedAt, status),
});

/** A registry in two pages; `changes` is what it answers to updated_since. */
function fakeRegistry(pages: unknown[][], changes: unknown[] = []) {
  const calls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.searchParams.get("updated_since")) return Response.json({ servers: changes, metadata: { count: changes.length } });
    const page = Number(url.searchParams.get("cursor") ?? 0);
    const next = page + 1 < pages.length ? String(page + 1) : undefined;
    return Response.json({ servers: pages[page], metadata: { nextCursor: next, count: pages[page]!.length } });
  }) as typeof fetch;
  return { fetcher, calls };
}

async function signUp() {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.org`, password: "correct-horse-battery", name: "Test" }),
    }),
  );
  return res.headers.get("set-auth-token")!;
}

async function search(token: string, query = "") {
  const res = await exports.default.fetch(new Request(`${BASE}/api/connectors/catalog${query}`, { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return (await res.json()) as CatalogPage;
}

describe("connector catalog", () => {
  it("keeps only servers it can add, with a usable title and sign-in", () => {
    const now = new Date();
    expect(catalogRow(entry("com.notion/mcp", { remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] }), now)).toMatchObject({
      id: "com.notion/mcp",
      title: "Notion",
      category: "productivity",
      auth: "oauth",
      url: "https://mcp.notion.com/mcp",
    });
    // SSE only, a templated address, a private address, no remote, or deprecated: not addable.
    expect(catalogRow(entry("a.b/sse", { remotes: [{ type: "sse", url: "https://b.a/sse" }] }), now)).toBeNull();
    expect(catalogRow(entry("a.b/t", { remotes: [{ type: "streamable-http", url: "https://{tenant}.b.a/mcp" }] }), now)).toBeNull();
    expect(catalogRow(entry("a.b/l", { remotes: [{ type: "streamable-http", url: "https://localhost/mcp" }] }), now)).toBeNull();
    expect(catalogRow(entry("a.b/p", { packages: [] }), now)).toBeNull();
    expect(catalogRow(entry("a.b/d", { remotes: [{ type: "streamable-http", url: "https://b.a/mcp" }] }, undefined, "deprecated"), now)).toBeNull();
    // A required header means a key to fill in.
    const keyed = catalogRow(
      entry("com.paypal.mcp/mcp", {
        title: "PayPal",
        remotes: [
          { type: "sse", url: "https://mcp.paypal.com/sse" },
          { type: "streamable-http", url: "https://mcp.paypal.com/mcp", headers: [{ name: "Authorization", isRequired: true, isSecret: true, description: "Bearer <token>" }] },
        ],
      }),
      now,
    );
    expect(keyed).toMatchObject({ category: "finance", title: "PayPal", url: "https://mcp.paypal.com/mcp", auth: "headers", headerName: "Authorization", headerPlaceholder: "Bearer <token>" });
    expect(titleFromName("io.github.acme/weather-tools")).toBe("Weather Tools");
    expect(titleFromName("com.figma.mcp/mcp")).toBe("Figma");
    expect(cleanTitle("Figma MCP Server")).toBe("Figma");
    expect(cleanTitle("Vercel Mcp")).toBe("Vercel");
    expect(cleanTitle("Atlassian Rovo MCP Server")).toBe("Atlassian Rovo");
    expect(cleanTitle("MCP")).toBe("MCP");
  });

  it("copies the registry, then only what changed, and searches the copy", async () => {
    const token = await signUp();
    expect((await search(token)).syncedAt).toBeNull();

    const remote = (url: string) => ({ remotes: [{ type: "streamable-http", url }] });
    const registry = fakeRegistry(
      [
        [
          entry("io.github.someone/notes", { title: "Notes", description: "Take notes.", ...remote("https://notes.example.net/mcp") }),
          entry("com.notion/mcp", { description: "Pages and databases.", ...remote("https://mcp.notion.com/mcp") }),
        ],
        [
          entry("app.linear/linear", { title: "Linear", description: "Issues.", ...remote("https://mcp.linear.app/mcp") }),
          entry("a.b/local-only", { title: "Local", packages: [{ registryType: "npm", identifier: "x" }] }),
        ],
      ],
      [
        entry("io.github.someone/notes", { title: "Notes", ...remote("https://notes.example.net/mcp") }, "2026-10-20T00:00:00Z", "deleted"),
        entry("com.example/new", { title: "Fresh", description: "New notes tool.", ...remote("https://new.example.net/mcp") }, "2026-10-20T00:00:00Z"),
      ],
    );
    expect(await syncCatalog(env, registry.fetcher)).toEqual({ read: 4, kept: 3 });
    expect(registry.calls.every((u) => u.searchParams.get("version") === "latest")).toBe(true);

    const all = await search(token);
    expect(all.syncedAt).not.toBeNull();
    // The well-known services first, in their order.
    expect(all.connectors.map((c) => c.id)).toEqual(["com.notion/mcp", "app.linear/linear", "io.github.someone/notes"]);
    expect(all.connectors[0]).toMatchObject({ title: "Notion", official: true, auth: "oauth" });

    // The next run asks only for changes; a removed server leaves the catalog.
    registry.calls.length = 0;
    await syncCatalog(env, registry.fetcher);
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]!.searchParams.get("updated_since")).toBeTruthy();
    expect(await catalogSize(env)).toBe(3);

    // Categories: guessed from the text, counted over the whole catalog, and filterable.
    expect(all.categories).toEqual(expect.arrayContaining([{ id: "productivity", count: 3 }]));
    expect((await search(token, "?category=productivity")).connectors).toHaveLength(3);
    expect((await search(token, "?category=finance")).connectors).toEqual([]);

    const notes = await search(token, "?q=notes");
    expect(notes.connectors.map((c) => c.id)).toEqual(["com.example/new"]);
    // Wildcards in the query are taken literally.
    expect((await search(token, "?q=%25")).connectors).toEqual([]);
    const paged = await exports.default.fetch(new Request(`${BASE}/api/connectors/catalog?offset=0`));
    expect(paged.status).toBe(401);
  });
});
