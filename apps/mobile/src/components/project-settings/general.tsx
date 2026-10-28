import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CloudCli, ProjectColor, ProjectIcon, TaskTarget, type UpdateProjectSettingsInput } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Href, useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../lib/session";
import { makeStyles, projectColors, radius, useColors, useTheme } from "../../theme";
import { PROJECT_ICONS, ProjectBadge } from "../project-badge";
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

      <Section title={t("projectSettings.look")} hint={t("projectSettings.lookDescription")}>
        <LookPicker name={name || s.name} icon={s.icon} color={s.color} disabled={!canManage} onChange={(input) => save.mutate(input)} />
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

/** The project's icon and color, with the badge as it will look; each pick saves. */
function LookPicker({
  name,
  icon,
  color,
  disabled,
  onChange,
}: {
  name: string;
  icon: ProjectIcon | null;
  color: ProjectColor | null;
  disabled: boolean;
  onChange: (input: { icon?: ProjectIcon | null; color?: ProjectColor | null }) => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const palette = projectColors[useTheme()];
  const tint = palette[color ?? "indigo"] ?? palette.indigo;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ alignItems: "center", paddingVertical: 4 }}>
        <ProjectBadge name={name} icon={icon} color={color} size={56} />
      </View>
      <Text style={styles.label}>{t("projectSettings.color")}</Text>
      <View style={styles.grid}>
        {[null, ...ProjectColor.options].map((c) => {
          const on = color === c;
          const swatch = palette[c ?? "indigo"] ?? palette.indigo;
          return (
            <Pressable
              key={c ?? "default"}
              accessibilityRole="radio"
              accessibilityLabel={c ? t(`projectColor.${c}`) : t("projectSettings.colorDefault")}
              accessibilityState={{ checked: on, disabled }}
              disabled={disabled}
              onPress={() => !on && onChange({ color: c })}
              style={[styles.option, on && styles.optionOn]}
            >
              <View style={[styles.swatch, { backgroundColor: swatch.mark }]}>
                {on && <Check size={14} strokeWidth={3} color={swatch.soft} />}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.label}>{t("projectSettings.icon")}</Text>
      <View style={styles.grid}>
        {[null, ...ProjectIcon.options].map((i) => {
          const on = icon === i;
          const Icon = i ? PROJECT_ICONS[i] : null;
          return (
            <Pressable
              key={i ?? "letter"}
              accessibilityRole="radio"
              accessibilityLabel={i ? t(`projectIcon.${i}`) : t("projectSettings.iconLetter")}
              accessibilityState={{ checked: on, disabled }}
              disabled={disabled}
              onPress={() => !on && onChange({ icon: i })}
              style={[styles.option, on && styles.optionOn]}
            >
              {Icon ? (
                <Icon size={18} color={on ? tint.mark : colors.muted} />
              ) : (
                <Text style={[styles.letter, { color: on ? tint.mark : colors.muted }]}>{name.trim()[0]?.toLocaleUpperCase() ?? "?"}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Owners only: deletes the project for everyone after typing its name, as on the web. */
export function DeleteProject({ projectId, name }: { projectId: string; name: string }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ["projects", server, projectId, "members"], queryFn: () => api.listMembers(projectId) });
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["projects", server, projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects", server] });
      router.dismissTo("/" as Href);
    },
  });

  return (
    <Section title={t("deleteProject.title")} hint={t("deleteProject.description")}>
      {confirming ? (
        <View style={{ gap: 10 }}>
          <Text style={styles.danger}>{t("deleteProject.confirmTitle", { name })}</Text>
          <Text style={styles.label}>{t("deleteProject.confirmBody", { count: Math.max(1, members.data?.length ?? 1) })}</Text>
          <Input value={typed} onChangeText={setTyped} placeholder={t("deleteProject.typeName", { name })} accessibilityLabel={t("deleteProject.typeName", { name })} />
          {remove.error && <Notice tone="bad">{errorMessage(remove.error, t("common.error"))}</Notice>}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button
              variant="ghost"
              style={{ flex: 1 }}
              onPress={() => {
                setConfirming(false);
                setTyped("");
                remove.reset();
              }}
            >
              {t("deleteProject.cancel")}
            </Button>
            <Button
              style={{ flex: 1, backgroundColor: colors.bad }}
              disabled={typed.trim() !== name.trim()}
              pending={remove.isPending}
              onPress={() =>
                Alert.alert(t("deleteProject.confirmTitle", { name }), t("deleteProject.description"), [
                  { text: t("deleteProject.cancel"), style: "cancel" },
                  { text: t("deleteProject.confirm"), style: "destructive", onPress: () => remove.mutate() },
                ])
              }
            >
              {t("deleteProject.confirm")}
            </Button>
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setConfirming(true)} style={styles.deleteRow}>
          <Text style={[styles.danger, { fontWeight: "600" }]}>{t("deleteProject.button")}</Text>
        </Pressable>
      )}
    </Section>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    label: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    option: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: "transparent",
    },
    optionOn: { borderColor: colors.edge, backgroundColor: colors.hover },
    swatch: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
    letter: { fontSize: 15, fontWeight: "600" },
    danger: { color: colors.bad, fontSize: 15 },
    deleteRow: { paddingVertical: 8 },
  }),
);
