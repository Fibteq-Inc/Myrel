import { ApiError } from "@myrel/client";
import type { Translate } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { ConnectorOffer, ConnectorSuggestion } from "@myrel/protocol";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { CircleCheck, CircleSlash, KeyRound, LoaderCircle, LogIn, Plug, Sparkles } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { api, platform } from "../../lib/api";
import { Button, cn, errorMessage, GhostButton, Input } from "../../lib/ui";
import { OfferIcon } from "../connectors";

/**
 * The thread agent's offer of a connector it needs: one to three services, connected with a click
 * (a sign-in in the browser when the service asks for one) as the viewer's own connector, on in
 * this project. Once connected, the agent carries on with it; "Not now" lets it carry on without.
 */
export function ConnectorSuggestionCard({
  suggestion,
  projectId,
  threadId,
}: {
  suggestion: ConnectorSuggestion;
  projectId: string;
  threadId: string;
}) {
  const t = useT();
  const titleId = useId();
  // The key an offer that needs one is waiting for, while its field is open.
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState("");
  // A sign-in from this card that came back without finishing (see the OAuth callback).
  const [signInFailed] = useState(() => platform.name === "web" && new URLSearchParams(window.location.search).get("connector") === "error");

  const connect = useMutation({
    mutationFn: (o: { offer: ConnectorOffer; headers?: Record<string, string> }) =>
      api.connectSuggestion(projectId, threadId, suggestion.id, { offerId: o.offer.id, ...(o.headers && { headers: o.headers }) }),
    onSuccess: (res) => {
      if (!res.authorizeUrl) return;
      if (platform.name === "web") window.location.assign(res.authorizeUrl);
      else void platform.openExternal(res.authorizeUrl);
    },
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissSuggestion(projectId, threadId, suggestion.id) });

  const open = suggestion.state === "open";
  const limited = connect.error instanceof ApiError && connect.error.status === 402;
  const error = connect.error ?? dismiss.error;
  const busy = connect.isPending || dismiss.isPending || (connect.isSuccess && !!connect.data.authorizeUrl && open);
  const connected = suggestion.offers.find((o) => o.id === suggestion.connected);

  function start(offer: ConnectorOffer) {
    if (offer.auth === "headers") {
      setKeyFor(offer.id);
      setKey("");
      return;
    }
    connect.mutate({ offer });
  }

  function submitKey(e: FormEvent, offer: ConnectorOffer) {
    e.preventDefault();
    if (!key.trim() || !offer.headerHint) return;
    connect.mutate({ offer, headers: { [offer.headerHint.name]: key.trim() } });
  }

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-3 rounded-xl border p-3.5", open ? "border-accent/40 bg-accent-soft/30" : "border-line bg-raised")}
    >
      <div className={cn("flex items-center gap-2 text-xs", open ? "text-accent" : "text-subtle")}>
        {suggestion.state === "connected" ? (
          <CircleCheck size={14} aria-hidden="true" />
        ) : suggestion.state === "dismissed" ? (
          <CircleSlash size={14} aria-hidden="true" />
        ) : (
          <Plug size={14} aria-hidden="true" />
        )}
        {suggestion.state === "connected"
          ? t("suggestion.connected", { name: connected?.name ?? "" })
          : suggestion.state === "dismissed"
            ? t("suggestion.dismissed")
            : t("suggestion.title")}
      </div>
      <div id={titleId} className="text-[13px] text-body">
        {suggestion.reason}
      </div>

      <div className="flex flex-col gap-2">
        {suggestion.offers.map((offer) => {
          const picked = offer.id === suggestion.connected;
          const pending = connect.isPending && connect.variables?.offer.id === offer.id;
          return (
            <div
              key={offer.id}
              className={cn(
                "flex flex-col gap-3 rounded-lg border px-3 py-2.5",
                picked ? "border-accent/60 bg-accent-soft" : "border-edge bg-panel",
                !open && !picked && "opacity-60",
              )}
            >
              <div className="flex items-center gap-3">
                <OfferIcon name={offer.name} featured={offer.featured} iconUrl={offer.iconUrl} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{offer.name}</span>
                    {offer.featured && <Sparkles size={12} className="flex-none text-accent" aria-hidden="true" />}
                  </div>
                  {offer.description && <p className="line-clamp-2 text-[13px] text-muted">{offer.description}</p>}
                </div>
                {open && keyFor !== offer.id && (
                  <Button type="button" className="h-8 flex-none px-3" disabled={busy} onClick={() => start(offer)}>
                    {pending ? (
                      <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                    ) : offer.auth === "headers" ? (
                      <KeyRound size={14} aria-hidden="true" />
                    ) : (
                      <LogIn size={14} aria-hidden="true" />
                    )}
                    {pending ? t("suggestion.connecting") : t("suggestion.connect")}
                  </Button>
                )}
                {picked && <CircleCheck size={16} className="flex-none text-accent" aria-hidden="true" />}
              </div>
              {open && keyFor === offer.id && offer.headerHint && (
                <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => submitKey(e, offer)}>
                  <Input
                    type="password"
                    autoFocus
                    autoComplete="off"
                    aria-label={t("suggestion.keyLabel", { name: offer.headerHint.name, service: offer.name })}
                    placeholder={offer.headerHint.placeholder || offer.headerHint.name}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <Button type="submit" className="flex-none" disabled={busy || !key.trim()}>
                    {pending && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
                    {t("suggestion.connect")}
                  </Button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      {open && (
        <>
          {limited ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-warn">
              {t("suggestion.limit")}
              <Link to="/settings/billing" className="font-medium text-accent hover:underline">
                {t("suggestion.upgrade")}
              </Link>
            </div>
          ) : error ? (
            <p className="text-[13px] text-bad">{suggestionError(error, t)}</p>
          ) : signInFailed && !connect.isPending ? (
            <p className="text-[13px] text-warn">{t("suggestion.signInFailed")}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-xs text-subtle">{t("suggestion.yours")}</p>
            <GhostButton type="button" className="flex-none" disabled={busy} onClick={() => dismiss.mutate()}>
              {t("suggestion.notNow")}
            </GhostButton>
          </div>
        </>
      )}
    </div>
  );
}

function suggestionError(err: unknown, t: Translate) {
  if (err instanceof ApiError) {
    if (err.status === 404) return t("suggestion.answered");
    const message = (err.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message) return message;
  }
  return errorMessage(err, t);
}
