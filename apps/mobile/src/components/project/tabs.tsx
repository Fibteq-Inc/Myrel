import type { LucideIcon } from "lucide-react-native";
import { ScrollView, Pressable, StyleSheet, Text, View } from "react-native";
import { makeStyles, mono, useColors } from "../../theme";

type Tab<K extends string> = { key: K; label: string; count?: number; icon?: LucideIcon };

/**
 * A row of section tabs under a header, scrollable when they don't fit. A count shows beside its label.
 * When the tabs carry icons they look like the web thread panel's: each tab is only its icon, the selected
 * one also shows its name, and a count sits on an unselected icon's corner.
 */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Tab<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const icons = tabs.every((tab) => tab.icon);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={styles.bar}
      contentContainerStyle={icons ? styles.iconRow : styles.row}
    >
      {icons ? (
        <View style={styles.group}>
          {tabs.map((tab) => {
            const selected = tab.key === value;
            const Icon = tab.icon!;
            return (
              <Pressable
                key={tab.key}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={tab.count ? `${tab.label} (${tab.count})` : tab.label}
                onPress={() => onChange(tab.key)}
                hitSlop={4}
                style={({ pressed }) => [
                  styles.iconTab,
                  selected && styles.iconSelected,
                  pressed && !selected && { backgroundColor: colors.hover },
                ]}
              >
                <Icon size={17} color={selected ? colors.fg : colors.muted} />
                {selected ? (
                  <Text numberOfLines={1} style={styles.iconLabel}>
                    {tab.label}
                    {tab.count ? <Text style={styles.count}>{` ${tab.count}`}</Text> : null}
                  </Text>
                ) : tab.count ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{tab.count}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        tabs.map((tab) => {
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
        })
      )}
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
    iconRow: { paddingHorizontal: 12, paddingVertical: 6 },
    group: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      padding: 2,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
    },
    iconTab: {
      minWidth: 36,
      height: 34,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: 8,
    },
    iconSelected: { backgroundColor: colors.hover, paddingLeft: 10, paddingRight: 12 },
    iconLabel: { maxWidth: 160, color: colors.fg, fontSize: 14, fontWeight: "500" },
    badge: {
      position: "absolute",
      top: 0,
      right: 0,
      minWidth: 15,
      paddingHorizontal: 3,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    badgeText: { color: colors.muted, fontFamily: mono, fontSize: 9, lineHeight: 13, textAlign: "center" },
  }),
);
