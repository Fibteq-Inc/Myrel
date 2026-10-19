import { z } from "zod";
import { ArtifactId, ProjectId, ThreadId, Timestamp } from "./models";

/**
 * A published page: versioned HTML in R2, served from a separate origin. Its
 * in-app address is stable; each publish to the same artifact adds a version.
 */
export const Artifact = z.object({
  id: ArtifactId,
  projectId: ProjectId,
  /** The thread that first published it; null if published outside a thread. */
  threadId: ThreadId.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  /** Latest version number, starting at 1. */
  version: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Artifact = z.infer<typeof Artifact>;

export const ArtifactVersion = z.object({
  version: z.number().int().positive(),
  /** Size of the HTML in bytes. */
  size: z.number().int().nonnegative(),
  /** The thread that published this version, if any. */
  threadId: ThreadId.nullable(),
  createdAt: Timestamp,
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

/** Returned by the API so a client can frame one version of an artifact. */
export const ArtifactView = z.object({
  version: z.number().int().positive(),
  /** Signed, short-lived URL on the artifact origin. null when no artifact origin is configured. */
  url: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
});
export type ArtifactView = z.infer<typeof ArtifactView>;

/** Largest HTML a single publish may carry. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

/** R2 key of one version's HTML. Shared by the API (writes) and the artifact Worker (reads). */
export function artifactObjectKey(artifactId: string, version: number): string {
  return `artifacts/${artifactId}/v${version}/index.html`;
}

/** Path of one version on the artifact origin, before the signature query. */
export function artifactPath(artifactId: string, version: number): string {
  return `/${artifactId}/v${version}/`;
}
