import type { AppUpdate, AppUpdater } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Notice, Section } from "./settings";
import { Button, GhostButton } from "../lib/ui";

/** The desktop app's version, with a button to look for a newer release and install it. */
export function AppUpdateSection({ updater }: { updater: AppUpdater }) {
  const t = useT();
  const { data: version } = useQuery({ queryKey: ["app-version"], queryFn: () => updater.version(), staleTime: Infinity });
  const check = useMutation({ mutationFn: () => updater.check() });
  const install = useMutation({ mutationFn: (update: AppUpdate) => update.install() });
  const update = check.data;

  return (
    <Section title={t("appUpdate.title")} description={version ? t("appUpdate.version", { version }) : undefined}>
      {update ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-raised px-4 py-3">
          <span className="flex-1 text-[13px]">{t("appUpdate.available", { version: update.version })}</span>
          <Button onClick={() => install.mutate(update)} disabled={install.isPending}>
            {install.isPending ? t("appUpdate.installing") : t("appUpdate.install")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <GhostButton onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? t("appUpdate.checking") : t("appUpdate.check")}
          </GhostButton>
          {check.isSuccess && <span className="text-[13px] text-subtle">{t("appUpdate.upToDate")}</span>}
        </div>
      )}
      {check.isError && <Notice>{t("appUpdate.checkFailed")}</Notice>}
      {install.isError && <Notice>{t("appUpdate.installFailed")}</Notice>}
    </Section>
  );
}
