import { ScrollView, Pressable, StyleSheet, Text } from "react-native";
import { makeStyles, mono, useColors } from "../../theme";

/** A row of section tabs under a header, scrollable when they don't fit. A count shows beside its label. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: K; label: string; count?: number }[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={styles.bar}
      contentContainerStyle={styles.row}
    >
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.count ? `${tab.label} (${tab.count})` : undefined}
            onPress={() => onChange(tab.key)}
            style={[styles.tab, selected && styles.selected]}
          >
            <Text style={[styles.text, selected && { color: colors.fg }]}>
              {tab.label}
              {tab.count ? <Text style={styles.count}>{` ${tab.count}`}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    bar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
    row: { paddingHorizontal: 12, gap: 4 },
    tab: { paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
    selected: { borderBottomColor: colors.accent },
    text: { color: colors.subtle, fontSize: 14, fontWeight: "500" },
    count: { color: colors.subtle, fontFamily: mono, fontSize: 12 },
  }),
);
