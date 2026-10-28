import { isThemePreference, THEME_PREFERENCES } from "@myrel/client";
import { LOCALE_NAMES, LOCALES, isLocale } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AppUpdateSection } from "../../../components/app-update";
import { Field, Notice, Section, Select } from "../../../components/settings";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog";
import { api, meQuery, platform, sessionQuery } from "../../../lib/api";
import { drafts } from "../../../lib/drafts";
import { currentPushSubscription } from "../../../lib/push";
import { setThemePreference, useThemePreference } from "../../../lib/theme";
import { Button, errorMessage, Input } from "../../../lib/ui";

type SettingsSearch = { section?: string; connector?: string; result?: string; project?: string };

export const Route = createFileRoute("/_app/settings/")({
  // A connector's OAuth sign-in comes back to /settings?section=connectors&connector=<id>&result=ok|error.
  validateSearch: (search: Record<string, unknown>): SettingsSearch => {
    const out: SettingsSearch = {};
    for (const k of ["section", "connector", "result", "project"] as const) {
      if (typeof search[k] === "string") out[k] = search[k];
    }
    return out;
  },
  beforeLoad: ({ search }) => {
    if (search.section !== "connectors") return;
    const back = { connector: search.connector, result: search.result };
    if (search.project) {
      throw redirect({ to: "/settings/projects/$projectId", params: { projectId: search.project }, search: back });
    }
    throw redirect({ to: "/settings/connectors", search: back });
  },
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

      <ThemeSection />

      {platform.updater && <AppUpdateSection updater={platform.updater} />}

      <DeleteAccount email={me.email} />
    </>
  );
}

const THEME_LABELS = { system: "settings.themeSystem", light: "settings.themeLight", dark: "settings.themeDark" } as const;

/** Light, dark or the device's theme; kept on this device like the language. */
function ThemeSection() {
  const t = useT();
  const preference = useThemePreference();
  return (
    <Section title={t("settings.theme")} description={t("settings.themeHint")}>
      <div className="max-w-60">
        <Select
          aria-label={t("settings.theme")}
          value={preference}
          onChange={(e) => isThemePreference(e.target.value) && setThemePreference(e.target.value)}
        >
          {THEME_PREFERENCES.map((p) => (
            <option key={p} value={p}>
              {t(THEME_LABELS[p])}
            </option>
          ))}
        </Select>
      </div>
    </Section>
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
      // The server dropped the account's push devices; the browser's subscription goes too.
      await (await currentPushSubscription().catch(() => null))?.unsubscribe().catch(() => false);
      await api.signOut().catch(() => {});
    },
    onSuccess: async () => {
      queryClient.clear();
      drafts.clear();
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
