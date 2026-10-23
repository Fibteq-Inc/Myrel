import { useT } from "@myrel/i18n/react";
import type { Artifact, ArtifactRef } from "@myrel/protocol";
import { AppWindow, ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { type Colors, makeStyles, radius, useColors } from "../theme";

/** Cards for the artifacts an agent delivered with a message. */
export function ArtifactCards({
  refs,
  artifacts,
  onOpen,
}: {
  refs: ArtifactRef[];
  /** Current artifacts by id, to show when a newer version exists. */
  artifacts: Record<string, Artifact>;
  onOpen: (artifactId: string, version?: number) => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      {refs.map((a) => {
        const current = artifacts[a.artifactId];
        const latest = current?.version ?? a.version;
        const older = a.version < latest;
        return (
          <Pressable
            key={`${a.artifactId}-${a.version}`}
            accessibilityRole="button"
            accessibilityLabel={t("artifacts.labelNamed", { title: current?.title ?? a.title })}
            onPress={() => onOpen(a.artifactId, older ? a.version : undefined)}
            style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.hover }]}
          >
            <View style={styles.icon}>
              <AppWindow size={17} color={colors.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title} numberOfLines={1}>
                {current?.title ?? a.title}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {older
                  ? t("artifacts.olderVersion", { version: a.version, latest })
                  : t("artifacts.cardVersion", { version: a.version })}
              </Text>
            </View>
            <ChevronRight size={15} color={colors.subtle} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** The artifact icon tile, shared with the project's Artifacts tab. */
const cardIcon = (colors: Colors): ViewStyle => ({
  width: 36,
  height: 36,
  borderRadius: 9,
  borderWidth: 1,
  borderColor: colors.edge,
  backgroundColor: colors.panel,
  alignItems: "center",
  justifyContent: "center",
});

export const useArtifactCardStyles = makeStyles((colors) => StyleSheet.create({ icon: cardIcon(colors) }));

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.card,
      backgroundColor: colors.raised,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    icon: cardIcon(colors),
    title: { color: colors.fg, fontSize: 14, fontWeight: "600" },
    meta: { color: colors.subtle, fontSize: 12 },
  }),
);
