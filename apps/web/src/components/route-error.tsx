import { ApiError } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { server } from "../lib/api";
import { reportError } from "../lib/errors";
import { Button, errorMessage, MyrelMark } from "../lib/ui";

/** How often a page that failed for want of a connection tries again by itself. */
const RETRY_MS = 5_000;

/** fetch rejects (TypeError) when the server cannot be reached at all; an answer from it is an ApiError. */
export function isNetworkError(err: unknown) {
  return !(err instanceof ApiError) && (err instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine));
}

/**
 * Shown when a page could not load, most often because the app opened without a connection.
 * Without a connection it keeps trying (every few seconds and as soon as the system says it is
 * back online), so the app recovers without being closed and opened again.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const t = useT();
  const router = useRouter();
  const offline = isNetworkError(error);
  const routeId = router.state.matches.at(-1)?.routeId ?? "?";
  useEffect(() => {
    if (!offline) reportError(error, routeId);
  }, [error, offline, routeId]);

  function retry() {
    reset();
    void router.invalidate();
  }

  useEffect(() => {
    if (!offline) return;
    const again = () => {
      reset();
      void router.invalidate();
    };
    window.addEventListener("online", again);
    const timer = setInterval(again, RETRY_MS);
    return () => {
      window.removeEventListener("online", again);
      clearInterval(timer);
    };
  }, [offline, reset, router]);

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 bg-ground px-6 text-center">
      <MyrelMark size={36} />
      <div className="flex max-w-sm flex-col gap-1.5">
        <h1 className="text-base font-semibold text-fg">
          {offline ? t("routeError.offlineTitle", { host: (server || location.origin).replace(/^https?:\/\//, "") }) : t("common.error")}
        </h1>
        <p className="text-[13px] text-muted">{offline ? t("routeError.offlineBody") : errorMessage(error, t)}</p>
      </div>
      <Button type="button" onClick={retry}>
        {t("routeError.retry")}
      </Button>
    </div>
  );
}
