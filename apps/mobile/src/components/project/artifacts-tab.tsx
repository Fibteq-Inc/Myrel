import { artifactList } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Artifact } from "@myrel/protocol";
import { AppWindow, Blocks, ChevronRight } from "lucide-react-native";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useOpenArtifact } from "../../lib/links";
import { useProject } from "../../lib/project";
import { makeStyles, radius, useColors } from "../../theme";
import { useArtifactCardStyles } from "../artifact-card";
import { useRelativeTime } from "../ui";
import { Empty } from "./empty";

/** The project's Library: every artifact its threads published. */
export function ArtifactsTab() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const artifactCardStyles = useArtifactCardStyles();
  const relativeTime = useRelativeTime();
  const { projectId, state } = useProject();
  const open = useOpenArtifact(projectId);
  const items = artifactList(state);

  if (items.length === 0) {
    return (
      <Empty
        icon={<Blocks size={22} color={colors.subtle} />}
        title={t("artifacts.projectEmpty")}
        body={t("artifacts.projectEmptyBody")}
      />
    );
  }

  return (
    <FlatList<Artifact>
      data={items}
      keyExtractor={(a) => a.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => {
        const origin = item.threadId ? state.threads[item.threadId]?.title : undefined;
        return (
          <Pressable
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
                {[t("artifacts.cardVersion", { version: item.version }), origin, relativeTime(item.updatedAt)]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <ChevronRight size={15} color={colors.subtle} />
          </Pressable>
        );
      }}
    />
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    list: { padding: 16, gap: 8 },
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
