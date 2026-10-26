import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CloudCli, TaskTarget, type UpdateProjectSettingsInput } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSession } from "../../lib/session";
import { Option, Sheet } from "../cli-picker";
import { Notice, Section, ValueRow } from "../settings-section";
import { Button, errorMessage, Input } from "../ui";

export const projectSettingsKey = (server: string, projectId: string) => ["project-settings", server, projectId] as const;

/** The project's settings and a save that updates them everywhere (the thread pickers read the same query). */
export function useProjectSettings(projectId: string) {
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: projectSettingsKey(server, projectId), queryFn: () => api.getProjectSettings(projectId) });
  const save = useMutation({
    mutationFn: (input: UpdateProjectSettingsInput) => api.updateProjectSettings(projectId, input),
    onSuccess: (next) => {
      queryClient.setQueryData(projectSettingsKey(server, projectId), next);
      // A new name shows in the project's header and the project list.
      return queryClient.invalidateQueries({ queryKey: ["projects", server] });
    },
  });
  return { settings, save };
}

/** Name, where tasks run and the CLI in the cloud, as in the web's General tab. */
export function GeneralSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const { settings, save } = useProjectSettings(projectId);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<"target" | "cloudCli" | null>(null);
  const saved = settings.data?.name ?? "";
  useEffect(() => setName(saved), [saved]);
  if (!settings.data) return null;
  const s = settings.data;
  const renamed = name.trim() !== "" && name.trim() !== s.name;

  return (
    <>
      <Section title={t("projectSettings.general")}>
        <View style={{ gap: 10 }}>
          <Input
            value={name}
            onChangeText={setName}
            maxLength={120}
            editable={canManage}
            accessibilityLabel={t("projectSettings.name")}
            placeholder={t("projectSettings.name")}
            autoCapitalize="sentences"
            returnKeyType="done"
            onSubmitEditing={() => renamed && save.mutate({ name: name.trim() })}
          />
          {canManage && renamed && (
            <Button onPress={() => save.mutate({ name: name.trim() })} pending={save.isPending && save.variables?.name !== undefined}>
              {t("settings.saveChanges")}
            </Button>
          )}
        </View>
      </Section>

      <Section title={t("projectSettings.tasks")} hint={t("projectSettings.tasksDescription")}>
        <ValueRow
          label={t("projectSettings.runTasks")}
          value={t(`projectSettings.taskTarget.${s.taskTarget}` as MessageKey)}
          onPress={canManage ? () => setOpen("target") : undefined}
        />
        <ValueRow
          label={t("projectSettings.cloudCli")}
          value={t(`projectSettings.cloudCli.${s.cloudCli}` as MessageKey)}
          onPress={canManage ? () => setOpen("cloudCli") : undefined}
        />
        {save.error && <Notice tone="bad">{errorMessage(save.error, t("common.error"))}</Notice>}
      </Section>

      <Sheet open={open === "target"} onClose={() => setOpen(null)} title={t("projectSettings.runTasks")} hint={t("projectSettings.tasksDescription")}>
        {TaskTarget.options.map((target) => (
          <Option
            key={target}
            kind="radio"
            wrap
            checked={s.taskTarget === target}
            title={t(`projectSettings.taskTarget.${target}` as MessageKey)}
            onPress={() => {
              if (target !== s.taskTarget) save.mutate({ taskTarget: target });
              setOpen(null);
            }}
          />
        ))}
      </Sheet>
      <Sheet open={open === "cloudCli"} onClose={() => setOpen(null)} title={t("projectSettings.cloudCli")} hint={t("projectSettings.cloudCliHint")}>
        {CloudCli.options.map((cli) => (
          <Option
            key={cli}
            kind="radio"
            checked={s.cloudCli === cli}
            title={t(`projectSettings.cloudCli.${cli}` as MessageKey)}
            onPress={() => {
              if (cli !== s.cloudCli) save.mutate({ cloudCli: cli });
              setOpen(null);
            }}
          />
        ))}
      </Sheet>
    </>
  );
}
