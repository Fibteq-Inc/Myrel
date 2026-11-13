import { fenceLanguage } from "@myrel/client";
import { highlightLines } from "@myrel/client/highlight";
import { useT } from "@myrel/i18n/react";
import { mayBeFileName, resolveFileCode, splitFilePaths } from "@myrel/protocol";
import * as Clipboard from "expo-clipboard";
import { Copy } from "lucide-react-native";
import { type ReactNode, useMemo } from "react";
import { type ImageStyle, Linking, Pressable, ScrollView, StyleSheet, Text, type TextStyle, View, type ViewStyle } from "react-native";
import { type MarkedStyles, MarkedTokenizer, Renderer, useMarkdown } from "react-native-marked";
import { DECISION_LANG, type DecisionAnswer, decisionIndex, parseDecision } from "../lib/decision";
import { useFileRefContext } from "../lib/file-refs";
import { unwrapHref, wrapHref } from "../lib/raw-href";
import { makeStyles, mono, radius, useColors, useTheme } from "../theme";
import { CodeLines } from "./code-view";
import { DecisionCard } from "./decision-card";

export type DecisionHandlers = {
  /** What answered each of the message's decision cards, in order (decisionState); undefined while open. */
  answers?: readonly (DecisionAnswer | undefined)[];
  /** `card`: which of the message's cards the option is on. */
  onChoose?: (label: string, card: number) => void;
};

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
    private readonly decision: (DecisionHandlers & { body: string }) | undefined,
    private readonly onLink: (href: string) => void,
    private readonly projectFiles: ReadonlySet<string>,
    private readonly linkStyle: TextStyle | undefined,
    selectable: boolean,
  ) {
    super({ selectable });
  }

  override code(text: string, language?: string, containerStyle?: ViewStyle, textStyle?: TextStyle): ReactNode {
    if (language === DECISION_LANG) {
      const decision = parseDecision(text);
      if (decision) {
        // Each card answers on its own: a pick on one leaves the message's other cards open.
        const card = Math.max(0, this.decision ? decisionIndex(this.decision.body, decision) : 0);
        const onChoose = this.decision?.onChoose;
        return (
          <DecisionCard
            key={this.getKey()}
            decision={decision}
            answer={this.decision?.answers?.[card]}
            onChoose={onChoose && ((label) => onChoose(label, card))}
          />
        );
      }
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

const OUTSIDE_LINK = /^(https?:|mailto:)/i;

function openOutside(href: string) {
  if (OUTSIDE_LINK.test(href)) void Linking.openURL(href).catch(() => {});
}

/** See OutsideMarkdown. */
class OutsideRenderer extends Renderer {
  constructor(private readonly imageLabel: (alt: string) => string) {
    super({ selectable: true });
  }

  override code(text: string, language?: string, containerStyle?: ViewStyle, textStyle?: TextStyle): ReactNode {
    return <CodeBlock key={this.getKey()} text={text} language={language} containerStyle={containerStyle} textStyle={textStyle} />;
  }

  override link(children: string | ReactNode[], href: string, styles?: TextStyle): ReactNode {
    const target = unwrapHref(href);
    if (!OUTSIDE_LINK.test(target)) return <Text key={this.getKey()}>{children}</Text>;
    return (
      <Text key={this.getKey()} accessibilityRole="link" style={styles} onPress={() => openOutside(target)}>
        {children}
      </Text>
    );
  }

  override image(uri: string, alt?: string, _style?: ImageStyle): ReactNode {
    return (
      <Text key={this.getKey()} accessibilityRole="link" style={outsideImage} onPress={() => openOutside(unwrapHref(uri))}>
        {this.imageLabel(alt || unwrapHref(uri))}
      </Text>
    );
  }

  override linkImage(href: string, imageUrl: string, alt?: string, style?: ImageStyle): ReactNode {
    return this.image(imageUrl, alt, style);
  }
}

const outsideImage: TextStyle = { textDecorationLine: "underline" };

/**
 * Markdown from outside the project (an issue, its comments), read by people. Unlike an agent's
 * message it can open nothing of the project: no decision cards, thread or file links. Only web and
 * mail links work, and an image stays a link: loading it would tell its host who read this.
 */
export function OutsideMarkdown({ body }: { body: string }) {
  const t = useT();
  const theme = useTheme();
  const markedStyles = useMarkedStyles();
  const renderer = useMemo(() => new OutsideRenderer((alt) => t("issues.image", { alt })), [t]);
  const elements = useMarkdown(body, { colorScheme: theme, renderer, tokenizer, styles: markedStyles });
  return <View>{elements}</View>;
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
  selectable = true,
}: {
  body: string;
  decision?: DecisionHandlers;
  onLink: (href: string) => void;
  /** Off in chat messages: a long press there opens the message's actions (with Select text) instead. */
  selectable?: boolean;
}) {
  const theme = useTheme();
  const markedStyles = useMarkedStyles();
  const { projectFiles } = useFileRefContext();
  const hasDecision = decision !== undefined;
  const answers = decision?.answers;
  const onChoose = decision?.onChoose;
  // Rebuilding the renderer re-parses the message, so only do it when what it draws changes.
  const renderer = useMemo(
    () => new MyrelRenderer(hasDecision ? { answers, onChoose, body } : undefined, onLink, projectFiles, markedStyles.link, selectable),
    [hasDecision, answers, onChoose, body, onLink, projectFiles, markedStyles.link, selectable],
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
