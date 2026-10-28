import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { type Href, Stack, useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ProjectBadge } from "../../../../../components/project-badge";
import { PROJECT_SETTINGS_SECTIONS, SECTION_INFO } from "../../../../../components/project-settings/sections";
import { Spinner } from "../../../../../components/ui";
import { useProject } from "../../../../../lib/project";
import { useSession } from "../../../../../lib/session";
import { makeStyles, radius, useColors } from "../../../../../theme";

/** A project's settings: the project at the top, then one row per section, each opening its own page. */
export default function ProjectSettingsScreen() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const project = useQuery({ queryKey: ["projects", server, projectId], queryFn: () => api.getProject(projectId) });
  const p = project.data;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: t("mobile.projectSettings") }} />
      {!p ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic">
          <View style={styles.head}>
            <ProjectBadge name={p.name} icon={p.icon} color={p.color} size={48} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={styles.hint}>{t("projectSettings.youAre", { role: t(`role.${p.role}`) })}</Text>
            </View>
          </View>
          <View style={styles.card}>
            {PROJECT_SETTINGS_SECTIONS.map((section, i) => {
              const { label, icon: Icon } = SECTION_INFO[section];
              return (
                <Pressable
                  key={section}
                  accessibilityRole="button"
                  onPress={() => router.push(`/projects/${projectId}/settings/${section}` as Href)}
                  style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && { backgroundColor: colors.hover }]}
                >
                  <View style={styles.icon}>
                    <Icon size={17} color={colors.muted} />
                  </View>
                  <Text style={styles.label}>{t(label)}</Text>
                  <ChevronRight size={16} color={colors.subtle} />
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    page: { padding: 16, gap: 20, paddingBottom: 48 },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    head: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 2 },
    name: { color: colors.fg, fontSize: 18, fontWeight: "600" },
    hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    card: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.raised, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
    divider: { borderTopWidth: 1, borderTopColor: colors.line },
    icon: { width: 30, height: 30, borderRadius: radius.sm, backgroundColor: colors.hover, alignItems: "center", justifyContent: "center" },
    label: { flex: 1, color: colors.fg, fontSize: 15 },
  }),
);
