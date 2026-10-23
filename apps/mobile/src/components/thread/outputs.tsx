import { useT } from "@myrel/i18n/react";
import type { Artifact } from "@myrel/protocol";
import { AppWindow, ChevronRight, FileText } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useOpenArtifact } from "../../lib/links";
import { makeStyles, radius, useColors } from "../../theme";
import { useArtifactCardStyles } from "../artifact-card";
import { Empty } from "../project/empty";
import { useRelativeTime } from "../ui";

/** What the thread published, newest first; a tap opens it in the artifact viewer. */
export function OutputsTab({ projectId, artifacts }: { projectId: string; artifacts: Artifact[] }) {
  const colors = useColors();
  const styles = useStyles();
  const artifactCardStyles = useArtifactCardStyles();
  const t = useT();
  const relativeTime = useRelativeTime();
  const open = useOpenArtifact(projectId);
  if (artifacts.length === 0) {
    return (
      <Empty
        icon={<FileText size={22} color={colors.subtle} />}
        title={t("workspace.outputsEmpty")}
        body={t("workspace.outputsEmptyBody")}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {artifacts.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={t("artifacts.labelNamed", { title: item.title })}
          onPress={() => open(item.id)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}
        >
          <View style={artifactCardStyles.icon}>
            <AppWindow size={17} color={colors.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={styles.title} numberOfLines={1}>
              {item.title}
            </Text>
            {!!item.description && (
              <Text style={styles.description} numberOfLines={2}>
                {item.description}
              </Text>
            )}
            <Text style={styles.meta} numberOfLines={1}>
              {t("artifacts.cardVersion", { version: item.version })} · {relativeTime(item.updatedAt)}
            </Text>
          </View>
          <ChevronRight size={15} color={colors.subtle} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    page: { padding: 16, gap: 8 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    title: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    description: { color: colors.muted, fontSize: 13, lineHeight: 18 },
    meta: { color: colors.subtle, fontSize: 12 },
  }),
);
