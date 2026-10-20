import { useT } from "@myrel/i18n/react";
import type { ApiKey, ProviderId } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Field, List, Notice, Row, Section, Select } from "../../../components/settings";
import { api, keysQuery, meQuery, providersQuery } from "../../../lib/api";
import { Button, errorMessage, IconButton, Input } from "../../../lib/ui";
import { useConfirm } from "../../../components/ui/confirm";
import { Checkbox } from "../../../components/ui/controls";

export const Route = createFileRoute("/_app/settings/keys")({
  component: KeysSettings,
});

function KeysSettings() {
  const t = useT();
  const confirm = useConfirm();
  const { data: me } = useQuery(meQuery);
  const { data: keys = [] } = useQuery(keysQuery);
  const { data: providers } = useQuery(providersQuery);
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keysQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
    ]);

  const [provider, setProvider] = useState<ProviderId>("fireworks");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [shared, setShared] = useState(false);
  const add = useMutation({
    mutationFn: () => api.addKey({ provider, label: label.trim(), key: key.trim(), scope: shared ? "instance" : "user" }),
    onSuccess: () => {
      setLabel("");
      setKey("");
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteKey(id), onSuccess: refresh });

  const providerName = (id: string) => providers?.providers.find((p) => p.id === id)?.name ?? id;
  const mine = keys.filter((k) => k.scope === "user");
  const instance = keys.filter((k) => k.scope === "instance");
  const isAdmin = me?.role === "admin";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  const keyRow = (k: ApiKey, canDelete: boolean) => (
    <Row key={k.id}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{k.label}</span>
          <Badge>{providerName(k.provider)}</Badge>
        </div>
        <div className="mt-0.5 font-mono text-xs text-subtle">{k.hint}</div>
      </div>
      {canDelete && (
        <IconButton
          type="button"
          aria-label={t("keys.deleteLabel", { label: k.label })}
          title={t("keys.delete")}
          disabled={remove.isPending}
          onClick={async () => {
            if (await confirm({ title: t("keys.deleteConfirm", { label: k.label }), action: t("keys.delete"), danger: true }))
              remove.mutate(k.id);
          }}
        >
          <Trash2 size={15} />
        </IconButton>
      )}
    </Row>
  );

  return (
    <>
      <Section
        title={t("keys.yours")}
        description={t("keys.yoursDescription")}
      >
        <List empty={t("keys.yoursEmpty")}>{mine.map((k) => keyRow(k, true))}</List>
      </Section>

      <Section title={t("keys.add")}>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("keys.provider")}>
              <Select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
                {(providers?.providers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("keys.label")}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("keys.labelPlaceholder")} maxLength={80} required />
            </Field>
          </div>
          <Field label={t("keys.apiKey")}>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-…"
              minLength={8}
              required
            />
          </Field>
          {isAdmin && (
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} />
              {t("keys.share")}
            </label>
          )}
          <Button type="submit" disabled={add.isPending || !label.trim() || key.trim().length < 8}>
            {t("keys.addButton")}
          </Button>
          {add.error && <Notice>{errorMessage(add.error, t)}</Notice>}
        </form>
      </Section>

      <Section
        title={t("keys.server")}
        description={t("keys.serverDescription")}
      >
        <List empty={t("keys.serverEmpty")}>{instance.map((k) => keyRow(k, isAdmin))}</List>
      </Section>
    </>
  );
}
