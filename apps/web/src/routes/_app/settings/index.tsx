import { LOCALE_NAMES, LOCALES, isLocale } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Field, Notice, Section, Select } from "../../../components/settings";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog";
import { api, meQuery, sessionQuery } from "../../../lib/api";
import { Button, errorMessage, Input } from "../../../lib/ui";

export const Route = createFileRoute("/_app/settings/")({
  component: AccountSettings,
});

function AccountSettings() {
  const { t, locale, setLocale } = useI18n();
  const { data: me } = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.name);
  const rename = useMutation({
    mutationFn: () => api.updateProfile({ name: name.trim() }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }),
      ]),
  });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const password = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
    },
  });

  function onRename(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) rename.mutate();
  }

  function onPassword(e: FormEvent) {
    e.preventDefault();
    password.mutate();
  }

  return (
    <>
      <Section
        title={t("settings.profile")}
        description={t(me.role === "admin" ? "settings.signedInAsAdmin" : "settings.signedInAs", { email: me.email })}
      >
        <form onSubmit={onRename} className="flex items-end gap-2">
          <div className="flex-1">
            <Field label={t("settings.name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </Field>
          </div>
          <Button type="submit" disabled={rename.isPending || !name.trim() || name.trim() === me.name}>
            {t("settings.save")}
          </Button>
        </form>
        {rename.error && <Notice>{errorMessage(rename.error, t)}</Notice>}
      </Section>

      <Section title={t("settings.password")} description={t("settings.passwordHint")}>
        <form onSubmit={onPassword} className="space-y-3">
          <Field label={t("settings.currentPassword")}>
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label={t("settings.newPassword")} hint={t("settings.newPasswordHint")}>
            <Input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={password.isPending}>
            {t("settings.changePassword")}
          </Button>
          {password.error && <Notice>{errorMessage(password.error, t)}</Notice>}
          {password.isSuccess && <Notice tone="ok">{t("settings.passwordChanged")}</Notice>}
        </form>
      </Section>

      <Section title={t("settings.language")} description={t("settings.languageHint")}>
        <div className="max-w-60">
          <Select
            aria-label={t("settings.language")}
            value={locale}
            onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </Select>
        </div>
      </Section>

      <DeleteAccount email={me.email} />
    </>
  );
}

/** Deletes the account after typing its email; projects only this person owns go with it. */
function DeleteAccount({ email }: { email: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: async () => {
      await api.deleteAccount();
      await api.signOut().catch(() => {});
    },
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });

  return (
    <Section title={t("deleteAccount.title")}>
      <div className="flex flex-col gap-3 rounded-xl border border-bad/40 bg-bad/5 px-4 py-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-[13px] text-muted">{t("deleteAccount.description")}</p>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex h-8 flex-none items-center justify-center rounded-lg border border-bad/50 px-3 text-[13px] font-medium text-bad hover:bg-bad/10"
        >
          {t("deleteAccount.button")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("deleteAccount.confirmTitle")}
          body={t("deleteAccount.confirmBody", { email })}
          confirmLabel={t("deleteAccount.confirm")}
          busyLabel={t("deleteAccount.deleting")}
          typeToConfirm={email}
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error, t) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => {
            setConfirming(false);
            remove.reset();
          }}
        />
      )}
    </Section>
  );
}
