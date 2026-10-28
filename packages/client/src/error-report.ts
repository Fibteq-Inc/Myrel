import type { ClientErrorInput } from "@myrel/protocol";
import { ApiError } from "./api";

/** At most this many reports from one app session; one kind of error is sent once. */
const MAX_REPORTS = 20;

/** No connection, a stopped request, or an error answer the server already knows about: nothing to report. */
export function isReportable(err: unknown): boolean {
  // The server counts its own 5xx answers; 4xx are expected answers.
  if (err instanceof ApiError) return false;
  if (!(err instanceof Error)) return err !== undefined && err !== null;
  if (err.name === "AbortError") return false;
  // fetch failing for want of a connection, in Chrome, Safari, Firefox and React Native.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return false;
  return true;
}

/**
 * Sends an app's own unexpected errors to its server (Settings › Server › Errors), once per kind
 * and at most MAX_REPORTS per session. Never throws, and a report that fails is dropped.
 */
export function createErrorReporter(options: {
  platform: ClientErrorInput["platform"];
  version?: string;
  send: (input: ClientErrorInput) => Promise<unknown>;
}) {
  const sent = new Set<string>();
  return (err: unknown, where: string) => {
    if (!isReportable(err) || sent.size >= MAX_REPORTS) return;
    const error = err instanceof Error ? err : new Error(String(err));
    const key = `${where}\n${error.name}\n${error.message}`;
    if (sent.has(key)) return;
    sent.add(key);
    void options
      .send({
        platform: options.platform,
        where: where.slice(0, 200) || "?",
        name: (error.name || "Error").slice(0, 100),
        message: (error.message || "").slice(0, 500),
        stack: error.stack?.slice(0, 4000),
        version: options.version?.slice(0, 40),
      })
      .catch(() => {});
  };
}
