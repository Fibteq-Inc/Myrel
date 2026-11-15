import { useT } from "@myrel/i18n/react";
import { cliLogins, COORDINATOR_CLIS, type CoordinatorCli, type CoordinatorInput, effortsFor, type Runner } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { runnersQueryKey } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { useNames } from "../../lib/use-names";
import { makeStyles } from "../../theme";
import { cliName, effortName, Option, Sheet, useOwnWorkspaces } from "../cli-picker";
import { Notice, Section, ValueRow } from "../settings-section";
import { errorMessage } from "../ui";
import { useProjectSettings } from "./general";

const coordinatorClis = (runner: Runner | undefined) => runner?.clis.filter((c) => (COORDINATOR_CLIS as readonly string[]).includes(c.id)) ?? [];

/**
 * How the coordinator works, as on the web: with the server's model, or with a CLI on one of your own
 * computers that has this project's folder. The computer, CLI, model and effort show only while a CLI
 * is picked, the CLI's login too when the computer has several, and only the computer's owner changes
 * them; others see whose computer it is and can switch it back to the server's model. Each pick saves.
 */
export function CoordinatorSettingsSection({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const styles = useStyles();
  const { api, server, user } = useSession();
  const { settings, save } = useProjectSettings(projectId);
  const own = useOwnWorkspaces(projectId);
  const { data: runners = [] } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners() });
  const names = useNames(projectId);
  const [open, setOpen] = useState<"mode" | "computer" | "cli" | "model" | "account" | null>(null);
  // No computer of yours to pick: say so rather than offer an empty list.
  const [noComputer, setNoComputer] = useState(false);
  if (!settings.data) return null;
  const saved = settings.data.coordinator;
  const mine = runners.filter((r) => own.some((w) => w.runnerId === r.id));
  const set = (input: CoordinatorInput) => {
    save.mutate({ coordinator: input });
    setOpen(null);
  };
  const onComputer = (runner: Runner) => {
    const cli = coordinatorClis(runner)[0]?.id as CoordinatorCli | undefined;
    if (cli) set({ mode: "cli", runnerId: runner.id, cli, model: null, effort: null, account: null });
    else setOpen(null);
  };

  const cliMode = saved.mode === "cli" ? saved : null;
  const elsewhere = cliMode && cliMode.by !== user?.id ? cliMode : null;
  const runner = cliMode ? runners.find((r) => r.id === cliMode.runnerId) : undefined;
  const clis = coordinatorClis(runner);
  const cli = clis.find((c) => c.id === cliMode?.cli);
  const models = cli?.models ?? [];
  const efforts = effortsFor(models, cliMode?.model ?? null);
  const pick = (model: string | null, effort: string | null) => {
    if (!cliMode || !cli) return;
    // An effort the model does not take would be dropped when it runs: clear it here instead.
    const kept = effort && effortsFor(models, model).includes(effort) ? effort : null;
    // No account: the saved login stays.
    set({ mode: "cli", runnerId: cliMode.runnerId, cli: cli.id as CoordinatorCli, model, effort: kept });
  };
  // Whose subscription its turns use, when the computer has more than the CLI's own login.
  const logins = cli?.accounts?.length ? cliLogins(cli) : [];
  const account = cliMode?.account ?? null;
  const accountLabel = logins.find((l) => l.account === account)?.name ?? (account && !logins.some((l) => l.account === account) ? account : t("cliPicker.ownLogin"));
  const pickAccount = (next: string | null) => {
    if (!cliMode || !cli) return;
    set({ mode: "cli", runnerId: cliMode.runnerId, cli: cli.id as CoordinatorCli, model: cliMode.model, effort: cliMode.effort, account: next });
  };
  const modelName = cliMode?.model ? (models.find((m) => m.id === cliMode.model)?.name ?? cliMode.model) : t("modelPicker.cliDefault");
  const effortLabel = cliMode?.effort ? effortName(cliMode.effort, t) : t("modelPicker.effortDefault");

  return (
    <Section title={t("coordinator.title")} hint={t("coordinator.description")}>
      <ValueRow
        label={t("coordinator.mode")}
        value={cliMode ? t("coordinator.modeCli") : t("coordinator.modeModel")}
        onPress={canManage ? () => setOpen("mode") : undefined}
      />
      {noComputer && !cliMode && <Notice tone="bad">{t("coordinator.noComputer")}</Notice>}
      {elsewhere ? (
        <Text style={styles.note}>
          {t("coordinator.elsewhere", { cli: cliName(elsewhere.cli), computer: elsewhere.computer, person: names[elsewhere.by] ?? t("coordinator.someone") })}
        </Text>
      ) : (
        cliMode && (
          <>
            <ValueRow label={t("coordinator.computer")} value={cliMode.computer} onPress={canManage && mine.length > 1 ? () => setOpen("computer") : undefined} />
            {runner && clis.length === 0 && <Notice tone="bad">{t("coordinator.noCli", { computer: runner.name })}</Notice>}
            {cli && (
              <>
                <ValueRow label={t("coordinator.cli")} value={cliName(cli.id)} onPress={canManage && clis.length > 1 ? () => setOpen("cli") : undefined} />
                {logins.length > 0 && (
                  <ValueRow label={t("coordinator.account")} value={accountLabel} onPress={canManage ? () => setOpen("account") : undefined} />
                )}
                <ValueRow
                  label={t("coordinator.model")}
                  value={[modelName, efforts.length > 0 && effortLabel].filter(Boolean).join(" · ")}
                  onPress={canManage && models.length > 0 ? () => setOpen("model") : undefined}
                />
              </>
            )}
            {runner && !runner.features.includes("coordinator") && <Notice tone="bad">{t("coordinator.oldRunner", { computer: runner.name })}</Notice>}
            <Text style={styles.note}>{t("coordinator.cliHint", { computer: cliMode.computer })}</Text>
          </>
        )
      )}
      {save.error && <Notice tone="bad">{errorMessage(save.error, t("common.error"))}</Notice>}

      <Sheet open={open === "mode"} onClose={() => setOpen(null)} title={t("coordinator.mode")}>
        <Option kind="radio" checked={!cliMode} title={t("coordinator.modeModel")} onPress={() => (cliMode ? set({ mode: "model" }) : setOpen(null))} />
        <Option
          kind="radio"
          checked={!!cliMode}
          title={t("coordinator.modeCli")}
          onPress={() => {
            if (cliMode) return setOpen(null);
            if (!mine[0]) {
              setNoComputer(true);
              return setOpen(null);
            }
            onComputer(mine[0]);
          }}
        />
      </Sheet>
      <Sheet open={open === "computer"} onClose={() => setOpen(null)} title={t("coordinator.computer")}>
        {mine.map((r) => (
          <Option key={r.id} kind="radio" checked={cliMode?.runnerId === r.id} title={r.name} onPress={() => onComputer(r)} />
        ))}
      </Sheet>
      <Sheet open={open === "cli"} onClose={() => setOpen(null)} title={t("coordinator.cli")}>
        {cliMode &&
          clis.map((c) => (
            <Option
              key={c.id}
              kind="radio"
              checked={cliMode.cli === c.id}
              title={cliName(c.id)}
              onPress={() => set({ mode: "cli", runnerId: cliMode.runnerId, cli: c.id as CoordinatorCli, model: null, effort: null, account: null })}
            />
          ))}
      </Sheet>
      <Sheet open={open === "account"} onClose={() => setOpen(null)} title={t("coordinator.account")}>
        {logins.map((l) => (
          <Option key={l.account ?? ""} kind="radio" checked={account === l.account} title={l.name ?? t("cliPicker.ownLogin")} onPress={() => pickAccount(l.account)} />
        ))}
        {/* A login the computer no longer has stays visible until someone changes it; its turns run with the CLI's own. */}
        {account && !logins.some((l) => l.account === account) && <Option kind="radio" checked title={account} onPress={() => setOpen(null)} />}
        <Text style={styles.note}>{t("coordinator.accountHint")}</Text>
      </Sheet>
      <Sheet open={open === "model"} onClose={() => setOpen(null)} title={t("coordinator.model")}>
        <ScrollView style={{ maxHeight: 280 }}>
          <Option kind="radio" checked={!cliMode?.model} title={t("modelPicker.cliDefault")} onPress={() => pick(null, cliMode?.effort ?? null)} />
          {/* A model the CLI no longer lists stays visible until someone changes it. */}
          {cliMode?.model && !models.some((m) => m.id === cliMode.model) && <Option kind="radio" checked title={cliMode.model} onPress={() => setOpen(null)} />}
          {models.map((m) => (
            <Option key={m.id} kind="radio" checked={cliMode?.model === m.id} title={m.name} onPress={() => pick(m.id, cliMode?.effort ?? null)} />
          ))}
        </ScrollView>
        <Text style={styles.part}>{t("modelPicker.effort")}</Text>
        {efforts.length > 0 ? (
          [null, ...efforts].map((e) => (
            <Option
              key={e ?? ""}
              kind="radio"
              checked={(cliMode?.effort ?? null) === e}
              title={e ? effortName(e, t) : t("modelPicker.effortDefault")}
              onPress={() => pick(cliMode?.model ?? null, e)}
            />
          ))
        ) : (
          <Text style={styles.note}>{t("modelPicker.noEffort")}</Text>
        )}
      </Sheet>
    </Section>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    note: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    part: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
  }),
);
