import { useI18n, useT } from "@myrel/i18n/react";
import type { BillingSummary } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, List, Notice, Row, Section } from "../../../components/settings";
import { api, billingQuery } from "../../../lib/api";
import { useFormat } from "../../../lib/format";
import { Button, cn, errorMessage, GhostButton, IconButton, Input } from "../../../lib/ui";

export const Route = createFileRoute("/_app/settings/billing")({
  component: BillingSettings,
});

/** List prices in USD; Stripe holds the real ones (see ee/billing/scripts/setup-stripe.mjs). */
const PRICES = { pro: { month: 15, year: 144 }, team: { month: 25, year: 240 } } as const;

function BillingSettings() {
  const t = useT();
  const { locale } = useI18n();
  const fmt = useFormat();
  const { data: billing, error } = useQuery(billingQuery);
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" }) : "");

  // Stripe pages open in this tab and come back to this page.
  const go = ({ url }: { url: string }) => location.assign(url);
  const portal = useMutation({ mutationFn: () => api.openBillingPortal(), onSuccess: go });

  if (error) return <Notice>{errorMessage(error, t)}</Notice>;
  if (!billing) return null;

  const status = billing.cancelAtPeriodEnd
    ? t("billing.endsOn", { date: date(billing.periodEnd) })
    : billing.status === "trialing"
      ? t("billing.trialEnds", { date: date(billing.trialEnd) })
      : billing.status === "past_due"
        ? t("billing.pastDue")
        : billing.periodEnd
          ? t("billing.renewsOn", { date: date(billing.periodEnd) })
          : t("billing.freeForever");

  return (
    <>
      <Section title={t("billing.title")} description={t("billing.description")}>
        <div className="rounded-xl border border-line bg-raised p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{t(`billing.plan.${billing.plan}`)}</span>
            {billing.plan === "team" && <Badge>{t("billing.seats", { count: billing.seats })}</Badge>}
            <span className="text-[13px] text-subtle">{status}</span>
            {billing.owner && billing.plan !== "free" && (
              <GhostButton type="button" className="ml-auto" disabled={portal.isPending} onClick={() => portal.mutate()}>
                {t("billing.manage")}
              </GhostButton>
            )}
          </div>
          {!billing.owner && <p className="mt-2 text-[13px] text-subtle">{t("billing.memberNote")}</p>}
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Meter
              label={t("billing.projects")}
              used={billing.usage.projects}
              limit={billing.limits.projects}
              text={(n) => String(n)}
            />
            <Meter
              label={t("billing.sandbox")}
              used={billing.usage.sandboxSeconds}
              limit={billing.limits.sandboxSeconds}
              text={(s) => t("billing.hours", { count: Math.round(s / 360) / 10 })}
            />
            <Meter
              label={t("billing.model")}
              used={billing.usage.modelMicros}
              limit={billing.limits.modelMicros}
              text={(m) => fmt.cost(m)}
            />
            <Meter
              label={t("billing.connectors")}
              used={billing.usage.connectors}
              limit={billing.limits.connectors}
              text={(n) => String(n)}
            />
          </div>
          <p className="mt-3 text-xs text-subtle">{t("billing.meterNote")}</p>
        </div>
        {portal.error && <Notice>{errorMessage(portal.error, t)}</Notice>}
      </Section>

      {billing.plan === "free" && billing.owner && <Plans billing={billing} />}
      {billing.plan === "team" && billing.owner && <TeamMembers billing={billing} />}
    </>
  );
}

function Meter({ label, used, limit, text }: { label: string; used: number; limit: number | null; text: (n: number) => string }) {
  const t = useT();
  const share = limit ? Math.min(1, used / limit) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="font-medium tabular-nums">
          {limit === null ? t("billing.unlimited", { used: text(used) }) : `${text(used)} / ${text(limit)}`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover" aria-hidden="true">
        <div className={cn("h-full rounded-full", share >= 1 ? "bg-bad" : "bg-accent")} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function Plans({ billing }: { billing: BillingSummary }) {
  const t = useT();
  const [interval, setInterval] = useState<"month" | "year">("month");
  const checkout = useMutation({
    mutationFn: (plan: "pro" | "team") => api.startCheckout({ plan, interval }),
    onSuccess: ({ url }) => location.assign(url),
  });
  const cta = billing.trialAvailable ? t("billing.startTrial") : t("billing.upgrade");

  return (
    <Section title={t("billing.choose")} description={billing.trialAvailable ? t("billing.trialNote") : undefined}>
      <div className="inline-flex rounded-lg border border-line bg-raised p-0.5 text-[13px]" role="group">
        {(["month", "year"] as const).map((i) => (
          <button
            key={i}
            type="button"
            aria-pressed={interval === i}
            onClick={() => setInterval(i)}
            className={cn("rounded-md px-3 py-1", interval === i ? "bg-hover text-fg" : "text-muted hover:text-fg")}
          >
            {t(i === "month" ? "billing.monthly" : "billing.yearly")}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["pro", "team"] as const).map((plan) => (
          <div key={plan} className="flex flex-col rounded-xl border border-line bg-raised p-4">
            <div className="text-base font-semibold">{t(`billing.plan.${plan}`)}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              ${PRICES[plan][interval]}
              <span className="ml-1 text-[13px] font-normal text-subtle">
                {t(plan === "team" ? `billing.per.seat.${interval}` : `billing.per.${interval}`)}
              </span>
            </div>
            <ul className="mt-3 flex-1 space-y-1.5 text-[13px] text-muted">
              {[1, 2, 3].map((n) => (
                <li key={n} className="flex gap-2">
                  <Check size={14} className="mt-0.5 flex-none text-accent" aria-hidden="true" />
                  {t(`billing.${plan}.feature${n}` as "billing.pro.feature1")}
                </li>
              ))}
            </ul>
            <Button type="button" className="mt-4" disabled={checkout.isPending} onClick={() => checkout.mutate(plan)}>
              {cta}
            </Button>
          </div>
        ))}
      </div>
      {checkout.error && <Notice>{errorMessage(checkout.error, t)}</Notice>}
    </Section>
  );
}

function TeamMembers({ billing }: { billing: BillingSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: billingQuery.queryKey });
  const [email, setEmail] = useState("");
  const add = useMutation({
    mutationFn: () => api.addTeamMember(email.trim()),
    onSuccess: () => {
      setEmail("");
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: (userId: string) => api.removeTeamMember(userId), onSuccess: refresh });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) add.mutate();
  };

  return (
    <Section title={t("billing.team")} description={t("billing.teamNote")}>
      <List empty={t("billing.noMembers")}>
        {billing.members.map((m) => (
          <Row key={m.userId}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{m.name}</div>
              <div className="truncate text-xs text-subtle">{m.email}</div>
            </div>
            <IconButton type="button" aria-label={t("billing.remove")} disabled={remove.isPending} onClick={() => remove.mutate(m.userId)}>
              <Trash2 size={15} />
            </IconButton>
          </Row>
        ))}
      </List>
      <form onSubmit={submit} className="flex gap-2">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("billing.memberEmail")} />
        <Button type="submit" disabled={add.isPending || !email.trim()}>
          {t("billing.add")}
        </Button>
      </form>
      {(add.error || remove.error) && <Notice>{errorMessage(add.error ?? remove.error, t)}</Notice>}
    </Section>
  );
}
