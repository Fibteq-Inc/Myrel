import { useT } from "@myrel/i18n/react";
import { type CliId, effortsFor, type RunnerCli } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { runnersQueryKey, workspaceQueryKey } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { makeStyles } from "../../theme";
import { cliName, effortName, Option, Sheet } from "../cli-picker";
import { Notice, Section, ValueRow } from "../settings-section";
import { errorMessage } from "../ui";
import { useProjectSettings } from "./general";

type Listing = RunnerCli & { models: NonNullable<RunnerCli["models"]> };

/**
 * The project's default model and effort for each CLI on its folder's computer, as on the web.
 * Only the computer's owner sees them (only their own computers are listed). Each pick saves.
 */
export function CliModelSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const styles = useStyles();
  const { api, server } = useSession();
  const { settings, save } = useProjectSettings(projectId);
  const { data: workspace } = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const { data: runners } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!workspace });
  const [open, setOpen] = useState<CliId | null>(null);
  const runner = workspace && runners?.find((r) => r.id === workspace.runnerId);
  if (!settings.data || !runner || runner.clis.length === 0) return null;
  const value = settings.data.cliModels;
  const listing = runner.clis.filter((c): c is Listing => !!c.models?.length);

  const set = (cli: Listing, model: string | null, effort: string | null) => {
    // An effort the model does not take would be dropped when it runs: clear it here instead.
    const next = { model, effort: effort && effortsFor(cli.models, model).includes(effort) ? effort : null };
    save.mutate({ cliModels: { ...value, [cli.id]: next } });
    setOpen(null);
  };
  const openCli = open && listing.find((c) => c.id === open);
  const current = openCli ? (value[openCli.id] ?? { model: null, effort: null }) : null;

  return (
    <Section title={t("projectSettings.cliModels")} hint={t("projectSettings.cliModelsDescription", { computer: runner.name })}>
      {listing.length === 0 ? (
        <Text style={styles.empty}>{t("projectSettings.cliModelsEmpty", { computer: runner.name })}</Text>
      ) : (
        listing.map((c) => {
          const own = value[c.id] ?? { model: null, effort: null };
          const efforts = effortsFor(c.models, own.model);
          const modelName = own.model ? (c.models.find((m) => m.id === own.model)?.name ?? own.model) : t("modelPicker.cliDefault");
          const effort = own.effort ? effortName(own.effort, t) : t("modelPicker.effortDefault");
          return (
            <ValueRow
              key={c.id}
              label={cliName(c.id)}
              value={efforts.length > 0 ? `${modelName} · ${effort}` : modelName}
              onPress={canManage ? () => setOpen(c.id) : undefined}
            />
          );
        })
      )}
      {save.error && <Notice tone="bad">{errorMessage(save.error, t("common.error"))}</Notice>}

      {openCli && current && (
        <Sheet open onClose={() => setOpen(null)} title={cliName(openCli.id)}>
          <ScrollView style={{ maxHeight: 280 }}>
            <Option kind="radio" checked={!current.model} title={t("modelPicker.cliDefault")} onPress={() => set(openCli, null, current.effort)} />
            {/* A default the CLI no longer lists stays visible until someone changes it. */}
            {current.model && !openCli.models.some((m) => m.id === current.model) && (
              <Option kind="radio" checked title={current.model} onPress={() => setOpen(null)} />
            )}
            {openCli.models.map((m) => (
              <Option key={m.id} kind="radio" checked={current.model === m.id} title={m.name} onPress={() => set(openCli, m.id, current.effort)} />
            ))}
          </ScrollView>
          <Text style={styles.part}>{t("modelPicker.effort")}</Text>
          {effortsFor(openCli.models, current.model).length > 0 ? (
            [null, ...effortsFor(openCli.models, current.model)].map((e) => (
              <Option
                key={e ?? ""}
                kind="radio"
                checked={(current.effort ?? null) === e}
                title={e ? effortName(e, t) : t("modelPicker.effortDefault")}
                onPress={() => set(openCli, current.model, e)}
              />
            ))
          ) : (
            <Text style={styles.empty}>{t("modelPicker.noEffort")}</Text>
          )}
        </Sheet>
      )}
    </Section>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    empty: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    part: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
  }),
);
