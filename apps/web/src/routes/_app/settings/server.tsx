import { useT } from "@myrel/i18n/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy, Trash2 } from "lucide-react";
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
      {info?.billing && <GiftLinks />}
    </>
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
