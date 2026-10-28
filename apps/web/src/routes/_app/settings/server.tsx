import { useT } from "@myrel/i18n/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, List, Notice, Row, Section } from "../../../components/settings";
import { adminSettingsQuery, api, serverInfoQuery } from "../../../lib/api";
import { useFormat } from "../../../lib/format";
import { Button, errorMessage, GhostButton, IconButton, Input } from "../../../lib/ui";
import { Select, Switch } from "../../../components/ui/controls";

export const Route = createFileRoute("/_app/settings/server")({
  component: ServerSettings,
});

function ServerSettings() {
  const t = useT();
  const { data: settings, error } = useQuery(adminSettingsQuery);
  const { data: info } = useQuery(serverInfoQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (signUpEnabled: boolean) => api.updateAdminSettings({ signUpEnabled }),
    onSuccess: (s) => {
      queryClient.setQueryData(adminSettingsQuery.queryKey, s);
      return queryClient.invalidateQueries({ queryKey: serverInfoQuery.queryKey });
    },
  });

  if (error) return <Notice>{errorMessage(error, t)}</Notice>;
  return (
    <>
      <Section title={t("server.signUps")} description={t("server.signUpsDescription")}>
        <label className="flex items-start gap-3 rounded-xl border border-line bg-raised px-4 py-3">
          <Switch
            className="mt-0.5"
            checked={settings?.signUpEnabled ?? false}
            disabled={!settings || update.isPending}
            onChange={(e) => update.mutate(e.target.checked)}
          />
          <span>
            <span className="block font-medium">{t("server.anyoneCanSignUp")}</span>
            <span className="block text-[13px] text-subtle">{t("server.anyoneCanSignUpHint")}</span>
          </span>
        </label>
        {update.error && <Notice>{errorMessage(update.error, t)}</Notice>}
      </Section>
      <Section
        title={t("server.sharedKeys")}
        description={
          <>
            {t("server.sharedKeysBefore")}{" "}
            <Link to="/settings/keys" className="text-accent hover:underline">
              {t("settings.keys")}
            </Link>
            {t("server.sharedKeysAfter")}
          </>
        }
      />
      <Funnel />
      <ServerErrors />
      {info?.billing && <GiftLinks />}
    </>
  );
}

const FUNNEL_DAYS = [7, 30, 90];
const FUNNEL_STEPS = ["signedUp", "verified", "inProject", "asked", "threadRan", "pairedComputer"] as const;

/** How far the people who signed up lately got, step by step, from what the server already keeps. */
function Funnel() {
  const t = useT();
  const [days, setDays] = useState(30);
  const { data: funnel, error } = useQuery({ queryKey: ["admin-funnel", days], queryFn: () => api.getAdminFunnel(days) });

  return (
    <Section title={t("server.funnel")} description={t("server.funnelDescription")}>
      <Select className="w-auto self-start" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t("server.funnelDays")}>
        {FUNNEL_DAYS.map((d) => (
          <option key={d} value={d}>
            {t("server.funnelDaysOption", { count: d })}
          </option>
        ))}
      </Select>
      {error && <Notice>{errorMessage(error, t)}</Notice>}
      <List empty="">
        {FUNNEL_STEPS.map((step) => {
          const value = funnel?.[step] ?? 0;
          const share = funnel?.signedUp ? Math.round((value / funnel.signedUp) * 100) : 0;
          return (
            <Row key={step}>
              <div className="min-w-0 flex-1">
                <div className="truncate">{t(`server.funnel.${step}`)}</div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                </div>
              </div>
              <span className="w-16 flex-none text-right tabular-nums">
                <span className="font-medium">{funnel ? value : "–"}</span>
                {funnel && step !== "signedUp" && <span className="ml-1.5 text-xs text-subtle">{share}%</span>}
              </span>
            </Row>
          );
        })}
      </List>
    </Section>
  );
}

/** The server's errors, grouped by kind, last seen first; one marked fixed goes away until it comes back. */
function ServerErrors() {
  const t = useT();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const { data: errors, error } = useQuery({ queryKey: ["admin-errors"], queryFn: () => api.listAdminErrors() });
  const clear = useMutation({
    mutationFn: (id: string) => api.clearAdminError(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-errors"] }),
  });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section title={t("server.errors")} description={t("server.errorsDescription")}>
      {(error || clear.error) && <Notice>{errorMessage(error ?? clear.error, t)}</Notice>}
      <List empty={t("server.errorsEmpty")}>
        {(errors ?? []).map((e) => (
          <Row key={e.id}>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
              <div className="truncate font-medium">{e.where}</div>
              <div className={open === e.id ? "break-words text-[13px] text-muted" : "truncate text-[13px] text-muted"}>
                {e.name}: {e.message}
              </div>
              <div className="truncate text-xs text-subtle">
                {t("server.errorSeen", { count: e.count })} · {fmt.relative(new Date(e.lastSeenAt).toISOString())}
              </div>
              {open === e.id && e.stack && (
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-raised p-2 text-[11.5px] text-subtle">{e.stack}</pre>
              )}
            </button>
            <Badge>{t(`server.errorSource.${e.source}`)}</Badge>
            <IconButton type="button" aria-label={t("server.errorFixed")} title={t("server.errorFixed")} disabled={clear.isPending} onClick={() => clear.mutate(e.id)}>
              <Check size={15} />
            </IconButton>
          </Row>
        ))}
      </List>
    </Section>
  );
}

const GIFT_MONTHS = [1, 3, 6, 12, 24];

/** Gift links: each gives one person Pro free for some months, with no card. */
function GiftLinks() {
  const t = useT();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const { data: gifts, error } = useQuery({ queryKey: ["gifts"], queryFn: () => api.listGifts() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["gifts"] });
  const [note, setNote] = useState("");
  const [months, setMonths] = useState(12);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.createGift({ note: note.trim(), months }),
    onSuccess: (res) => {
      setUrl(res.url);
      setCopied(false);
      setNote("");
      return refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeGift(id), onSuccess: refresh });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const copy = async () => {
    if (!url) return;
    await navigator.clipboard?.writeText(url);
    setCopied(true);
  };

  return (
    <Section title={t("server.gifts")} description={t("server.giftsDescription")}>
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("server.giftNote")} maxLength={200} />
        <Select className="w-auto" value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label={t("server.giftMonths")}>
          {GIFT_MONTHS.map((m) => (
            <option key={m} value={m}>
              {t("server.giftMonthsOption", { count: m })}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={create.isPending}>
          {t("server.giftCreate")}
        </Button>
      </form>
      {url && (
        <div className="rounded-xl border border-line bg-raised p-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-[13px]">{url}</code>
            <GhostButton type="button" onClick={copy}>
              <Copy size={14} aria-hidden="true" /> {copied ? t("server.giftCopied") : t("server.giftCopy")}
            </GhostButton>
          </div>
          <p className="mt-2 text-xs text-subtle">{t("server.giftOnce")}</p>
        </div>
      )}
      {(error || create.error || revoke.error) && <Notice>{errorMessage(error ?? create.error ?? revoke.error, t)}</Notice>}
      <List empty={t("server.giftsEmpty")}>
        {(gifts ?? []).map((g) => (
          <Row key={g.id}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{g.note || t("server.giftNoNote")}</div>
              <div className="truncate text-xs text-subtle">
                {t("server.giftMonthsOption", { count: g.months })} · {g.person ? `${g.person.name} (${g.person.email})` : fmt.relative(g.createdAt)}
              </div>
            </div>
            <Badge>{t(`server.giftStatus.${g.status}`)}</Badge>
            {(g.status === "open" || g.status === "claimed") && (
              <IconButton type="button" aria-label={t("server.giftRevoke")} disabled={revoke.isPending} onClick={() => revoke.mutate(g.id)}>
                <Trash2 size={15} />
              </IconButton>
            )}
          </Row>
        ))}
      </List>
    </Section>
  );
}
