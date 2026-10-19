import { type Artifact, artifactObjectKey, type ArtifactVersion, createId, MAX_ARTIFACT_BYTES } from "@altair/protocol";

type SqlValue = string | number | boolean | null;
/** The Agent's `this.sql` tagged template. */
type Sql = <T = Record<string, SqlValue>>(strings: TemplateStringsArray, ...values: SqlValue[]) => T[];

type ArtifactRow = {
  id: string;
  thread_id: string | null;
  title: string;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type VersionRow = { artifact_id: string; version: number; size: number; thread_id: string | null; created_at: string };

export type PublishInput = {
  /** Omit to publish a new artifact; pass an existing id to add a version to it. */
  artifactId?: string;
  title: string;
  description?: string | null;
  html: string;
  threadId: string | null;
};

export class ArtifactError extends Error {}

/**
 * A project's artifacts: the index and version history live in the ProjectAgent's
 * SQLite, each version's HTML in R2 under `artifacts/{id}/v{n}/index.html`.
 * Versions are immutable; publishing again adds one.
 */
export class ArtifactStore {
  constructor(
    private readonly sql: Sql,
    private readonly bucket: R2Bucket,
    private readonly projectId: string,
  ) {
    this.sql`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      size INTEGER NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version)
    )`;
  }

  async publish(input: PublishInput): Promise<Artifact> {
    const title = input.title.trim();
    if (!title) throw new ArtifactError("An artifact needs a title.");
    const body = new TextEncoder().encode(input.html);
    if (body.byteLength === 0) throw new ArtifactError("The artifact's HTML is empty.");
    if (body.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ArtifactError(`The artifact is ${body.byteLength} bytes; the limit is ${MAX_ARTIFACT_BYTES}.`);
    }

    const now = new Date().toISOString();
    const previous = input.artifactId ? this.get(input.artifactId) : null;
    if (input.artifactId && !previous) throw new ArtifactError(`No artifact ${input.artifactId} in this project.`);
    const id = previous?.id ?? createId("artifact");
    const version = (previous?.version ?? 0) + 1;
    const description = input.description === undefined ? (previous?.description ?? null) : input.description;

    // Claim the version number before the first await, so a concurrent publish takes the next one.
    if (previous) {
      this.sql`UPDATE artifacts SET title = ${title}, description = ${description}, version = ${version},
        updated_at = ${now} WHERE id = ${id}`;
    } else {
      this.sql`INSERT INTO artifacts (id, thread_id, title, description, version, created_at, updated_at)
        VALUES (${id}, ${input.threadId}, ${title}, ${description}, ${version}, ${now}, ${now})`;
    }
    this.sql`INSERT INTO artifact_versions (artifact_id, version, size, thread_id, created_at)
      VALUES (${id}, ${version}, ${body.byteLength}, ${input.threadId}, ${now})`;

    try {
      await this.bucket.put(artifactObjectKey(id, version), body, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { projectId: this.projectId, title },
      });
    } catch (err) {
      this.sql`DELETE FROM artifact_versions WHERE artifact_id = ${id} AND version = ${version}`;
      if (previous) {
        this.sql`UPDATE artifacts SET title = ${previous.title}, description = ${previous.description},
          version = (SELECT COALESCE(MAX(version), 1) FROM artifact_versions WHERE artifact_id = ${id}),
          updated_at = ${previous.updatedAt} WHERE id = ${id}`;
      } else {
        this.sql`DELETE FROM artifacts WHERE id = ${id}`;
      }
      throw err;
    }
    return this.get(id)!;
  }

  get(id: string): Artifact | null {
    const [row] = this.sql<ArtifactRow>`SELECT * FROM artifacts WHERE id = ${id}`;
    return row ? this.toArtifact(row) : null;
  }

  /** Newest first. */
  list(): Artifact[] {
    return this.sql<ArtifactRow>`SELECT * FROM artifacts ORDER BY updated_at DESC`.map((r) => this.toArtifact(r));
  }

  /** Newest first. */
  versions(id: string): ArtifactVersion[] {
    return this.sql<VersionRow>`SELECT * FROM artifact_versions WHERE artifact_id = ${id} ORDER BY version DESC`.map(
      (r) => ({ version: r.version, size: r.size, threadId: r.thread_id, createdAt: r.created_at }),
    );
  }

  hasVersion(id: string, version: number): boolean {
    return this.sql`SELECT 1 FROM artifact_versions WHERE artifact_id = ${id} AND version = ${version}`.length > 0;
  }

  private toArtifact(r: ArtifactRow): Artifact {
    return {
      id: r.id,
      projectId: this.projectId,
      threadId: r.thread_id,
      title: r.title,
      description: r.description,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
