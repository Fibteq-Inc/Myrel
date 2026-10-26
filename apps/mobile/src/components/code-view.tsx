import { type CodeLine, highlightLines, type TokenKind } from "@myrel/client/highlight";
import { useMemo } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { type Colors, makeStyles, mono, useColors } from "../theme";

function tokenColor(colors: Colors, kind: TokenKind) {
  switch (kind) {
    case "keyword":
      return colors.accent;
    case "string":
    case "addition":
      return colors.ok;
    case "number":
      return colors.warn;
    case "comment":
      return colors.subtle;
    case "name":
      return colors.link;
    case "type":
      return colors.merged;
    case "meta":
      return colors.muted;
    case "deletion":
      return colors.bad;
  }
}

/**
 * A code file with syntax colors and line numbers, the same tokens the web preview draws.
 * Lines are a list so long files scroll without drawing every line at once.
 */
export function CodeView({ text, language }: { text: string; language: string }) {
  const colors = useColors();
  const styles = useStyles();
  const lines = useMemo(() => highlightLines(text, language), [text, language]);
  const width = String(lines.length).length * 8 + 12;

  const renderLine = ({ item, index }: { item: CodeLine; index: number }) => {
    const kind = item[0]?.kind;
    return (
      <View
        style={[
          styles.row,
          kind === "addition" && { backgroundColor: colors.okSoft },
          kind === "deletion" && { backgroundColor: colors.badSoft },
        ]}
      >
        <Text style={[styles.number, { width }]} accessible={false}>
          {index + 1}
        </Text>
        <Text selectable style={styles.code}>
          {item.map((token, i) =>
            token.kind ? (
              <Text key={i} style={{ color: tokenColor(colors, token.kind), fontStyle: token.kind === "comment" ? "italic" : "normal" }}>
                {token.text}
              </Text>
            ) : (
              token.text
            ),
          )}
        </Text>
      </View>
    );
  };

  return (
    <FlatList
      data={lines}
      renderItem={renderLine}
      keyExtractor={(_, i) => String(i)}
      contentContainerStyle={styles.list}
      initialNumToRender={60}
      maxToRenderPerBatch={80}
      windowSize={11}
    />
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    list: { paddingVertical: 12 },
    row: { flexDirection: "row", paddingRight: 16 },
    number: { color: colors.subtle, fontFamily: mono, fontSize: 13, lineHeight: 19, textAlign: "right", paddingRight: 12 },
    code: { flex: 1, color: colors.body, fontFamily: mono, fontSize: 13, lineHeight: 19 },
  }),
);
