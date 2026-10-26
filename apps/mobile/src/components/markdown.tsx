import { fenceLanguage } from "@myrel/client";
import { highlightLines } from "@myrel/client/highlight";
import { useT } from "@myrel/i18n/react";
import { mayBeFileName, resolveFileCode, splitFilePaths } from "@myrel/protocol";
import * as Clipboard from "expo-clipboard";
import { Copy } from "lucide-react-native";
import { type ReactNode, useMemo } from "react";
import { type ImageStyle, Pressable, ScrollView, StyleSheet, Text, type TextStyle, View, type ViewStyle } from "react-native";
import { type MarkedStyles, MarkedTokenizer, Renderer, useMarkdown } from "react-native-marked";
import { DECISION_LANG, parseDecision } from "../lib/decision";
import { useFileRefContext } from "../lib/file-refs";
import { unwrapHref, wrapHref } from "../lib/raw-href";
import { makeStyles, mono, radius, useColors, useTheme } from "../theme";
import { CodeLines } from "./code-view";
import { DecisionCard } from "./decision-card";

export type DecisionHandlers = { answer?: string; onChoose?: (label: string) => void };

/** Keeps link targets as written (see wrapHref), so thread links and relative file paths survive parsing. */
class RawHrefTokenizer extends MarkedTokenizer {
  override link(src: string) {
    const token = super.link(src);
    if (token?.type === "link") token.href = wrapHref(token.href);
    return token;
  }

  override reflink(src: string, links: Parameters<MarkedTokenizer["reflink"]>[1]) {
    const token = super.reflink(src, links);
    if (token?.type === "link") token.href = wrapHref(token.href);
    return token;
  }
}

// The lexer binds it to itself on each (synchronous) parse, so one instance serves every message.
const tokenizer = new RawHrefTokenizer();

/** Draws ```decision blocks as cards, code with a copy button, and routes links (and file paths in code) to `onLink`. */
class MyrelRenderer extends Renderer {
  constructor(
    private readonly decision: DecisionHandlers | undefined,
    private readonly onLink: (href: string) => void,
    private readonly projectFiles: ReadonlySet<string>,
    private readonly linkStyle: TextStyle | undefined,
  ) {
    super({ selectable: true });
  }

  override code(text: string, language?: string, containerStyle?: ViewStyle, textStyle?: TextStyle): ReactNode {
    if (language === DECISION_LANG) {
      const decision = parseDecision(text);
      if (decision) return <DecisionCard key={this.getKey()} decision={decision} {...this.decision} />;
    }
    return <CodeBlock key={this.getKey()} text={text} language={language} containerStyle={containerStyle} textStyle={textStyle} />;
  }

  // Project file paths written as plain text open the file too: agents do not always link them.
  override text(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    if (typeof text !== "string") return super.text(text, styles);
    const parts = splitFilePaths(text, this.projectFiles);
    if (parts.length === 1 && typeof parts[0] === "string") return super.text(text, styles);
    return super.text(
      parts.map((part) => (typeof part === "string" ? part : this.link(part.text, part.path, { ...styles, ...this.linkStyle }))),
      styles,
    );
  }

  override codespan(text: string, styles?: TextStyle): ReactNode {
    if (!mayBeFileName(text)) return super.codespan(text, styles);
    return <FileCodespan key={this.getKey()} text={text} style={styles} onLink={this.onLink} />;
  }

  override link(children: string | ReactNode[], href: string, styles?: TextStyle): ReactNode {
    return (
      <Text key={this.getKey()} accessibilityRole="link" style={styles} onPress={() => this.onLink(unwrapHref(href))}>
        {children}
      </Text>
    );
  }

  override linkImage(href: string, imageUrl: string, alt?: string, style?: ImageStyle, title?: string): ReactNode {
    return (
      <Pressable key={this.getKey()} accessibilityRole="link" onPress={() => this.onLink(unwrapHref(href))}>
        {this.image(imageUrl, alt, style, title)}
      </Pressable>
    );
  }
}

/** Inline code naming a file: tappable when the file can be opened (see useOpenLink), otherwise just code. */
function FileCodespan({ text, style, onLink }: { text: string; style?: TextStyle; onLink: (href: string) => void }) {
  const styles = useStyles();
  const file = resolveFileCode(text, useFileRefContext());
  if (!file) {
    return (
      <Text selectable style={style}>
        {text}
      </Text>
    );
  }
  return (
    <Text accessibilityRole="link" style={[style, styles.fileCode]} onPress={() => onLink(file.path)}>
      {text}
    </Text>
  );
}

function CodeBlock({
  text,
  language,
  containerStyle,
  textStyle,
}: {
  text: string;
  language?: string;
  containerStyle?: ViewStyle;
  textStyle?: TextStyle;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const grammar = language ? fenceLanguage(language) : undefined;
  const lines = useMemo(() => (grammar ? highlightLines(text, grammar) : null), [text, grammar]);
  return (
    <View style={[containerStyle, styles.code]}>
      <View style={styles.codeHead}>
        <Text style={styles.codeLang}>{language || "text"}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.copy")}
          hitSlop={10}
          onPress={() => void Clipboard.setStringAsync(text)}
        >
          <Copy size={16} color={colors.subtle} />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12 }}>
        <Text selectable style={[textStyle, styles.codeText]}>
          {lines ? <CodeLines lines={lines} /> : text}
        </Text>
      </ScrollView>
    </View>
  );
}

const useMarkedStyles = makeStyles((colors): MarkedStyles => ({
  text: { color: colors.body, fontSize: 16, lineHeight: 24 },
  paragraph: { paddingVertical: 0, marginBottom: 10 },
  strong: { color: colors.fg, fontWeight: "600" },
  link: { color: colors.link, fontStyle: "normal" },
  h1: { color: colors.fg, fontSize: 19, fontWeight: "600", borderBottomWidth: 0, paddingBottom: 0, marginBottom: 8 },
  h2: { color: colors.fg, fontSize: 17, fontWeight: "600", borderBottomWidth: 0, paddingBottom: 0, marginBottom: 8 },
  h3: { color: colors.fg, fontSize: 16, fontWeight: "600", marginBottom: 6 },
  codespan: { color: colors.fg, backgroundColor: colors.hover, fontFamily: mono, fontSize: 14, fontStyle: "normal" },
  code: { padding: 0, marginBottom: 10 },
  codeText: { color: colors.body },
  blockquote: { borderLeftColor: colors.edge, borderLeftWidth: 2, paddingLeft: 10, backgroundColor: "transparent" },
  li: { color: colors.body, fontSize: 16, lineHeight: 24 },
  list: { marginBottom: 10 },
  hr: { backgroundColor: colors.line, marginVertical: 12 },
  table: { borderColor: colors.line },
  tableCell: { borderColor: colors.line, padding: 6 },
}));

/** Agent message markdown, also used for .md files in the file screen. */
export function MessageMarkdown({
  body,
  decision,
  onLink,
}: {
  body: string;
  decision?: DecisionHandlers;
  onLink: (href: string) => void;
}) {
  const theme = useTheme();
  const markedStyles = useMarkedStyles();
  const { projectFiles } = useFileRefContext();
  const hasDecision = decision !== undefined;
  const answer = decision?.answer;
  const onChoose = decision?.onChoose;
  // Rebuilding the renderer re-parses the message, so only do it when what it draws changes.
  const renderer = useMemo(
    () => new MyrelRenderer(hasDecision ? { answer, onChoose } : undefined, onLink, projectFiles, markedStyles.link),
    [hasDecision, answer, onChoose, onLink, projectFiles, markedStyles.link],
  );
  const elements = useMarkdown(body, { colorScheme: theme, renderer, tokenizer, styles: markedStyles });
  return <View>{elements}</View>;
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    code: {
      padding: 0,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.sunken,
      overflow: "hidden",
    },
    codeHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    codeLang: { color: colors.subtle, fontFamily: mono, fontSize: 13 },
    codeText: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: colors.body },
    fileCode: { color: colors.link, textDecorationLine: "underline" },
  }),
);
