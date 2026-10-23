import { useI18n, useT } from "@myrel/i18n/react";
import { type Task, type TerminalLine, unwrapShell } from "@myrel/protocol";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ExternalLink,
  GitCompareArrows,
  GitPullRequest,
  Square,
  SquareTerminal,
} from "lucide-react-native";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatDuration } from "../../lib/format";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Empty } from "../project/empty";
import { errorMessage, Spinner } from "../ui";

/** Every task the thread's agent ran, newest last. The running one opens by itself; finished ones stay folded. */
export function TerminalTab({ projectId, tasks, output }: { projectId: string; tasks: Task[]; output: Record<string, TerminalLine[]> }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  // Follows new output while the reader is at the bottom; scrolling up stops that.
  const pinned = useRef(true);
  if (tasks.length === 0) {
    return (
      <Empty
        icon={<SquareTerminal size={22} color={colors.subtle} />}
        title={t("workspace.terminalEmpty")}
        body={t("workspace.terminalEmptyBody")}
      />
    );
  }
  return (
    <ScrollView
      ref={list}
      contentContainerStyle={styles.page}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        pinned.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 40;
      }}
      scrollEventThrottle={100}
      onContentSizeChange={() => pinned.current && list.current?.scrollToEnd({ animated: false })}
    >
      {tasks.map((task) => (
        <TaskRow key={task.id} projectId={projectId} task={task} lines={output[task.id] ?? []} />
      ))}
    </ScrollView>
  );
}

/** What each finished run changed: its summary and the pull request it opened. */
export function ChangesTab({ tasks }: { tasks: Task[] }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  if (tasks.length === 0) {
    return (
      <Empty
        icon={<GitCompareArrows size={22} color={colors.subtle} />}
        title={t("workspace.changesEmpty")}
        body={t("workspace.changesEmptyBody")}
      />
    );
  }
  const finished = tasks.filter((task) => task.status !== "running");
  if (finished.length === 0) {
    return (
      <Empty
        icon={<GitPullRequest size={22} color={colors.subtle} />}
        title={t("tasks.inProgressTitle")}
        body={t("tasks.inProgressBody")}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {[...finished].reverse().map((task) => (
        <View key={task.id} style={styles.card}>
          <View style={styles.head}>
            <StatusIcon status={task.status} />
            <Text style={styles.title} numberOfLines={1}>
              {task.title}
            </Text>
            {task.prUrl && <PullRequestLink url={task.prUrl} />}
          </View>
          {!!task.summary && (
            <Text style={styles.summary} numberOfLines={8}>
              {task.summary}
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

function PullRequestLink({ url }: { url: string }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void Linking.openURL(url).catch(() => {})}
      hitSlop={6}
      style={styles.action}
    >
      <Text style={styles.link}>{t("tasks.pullRequest")}</Text>
      <ExternalLink size={12} color={colors.accent} />
    </Pressable>
  );
}

function TaskRow({ projectId, task, lines }: { projectId: string; task: Task; lines: TerminalLine[] }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const { api } = useSession();
  const running = task.status === "running";
  const [open, setOpen] = useState(running);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const now = useNow(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const started = Date.parse(task.createdAt);
  const total = (task.finishedAt ? Date.parse(task.finishedAt) : now) - started;
  const lastAt = lines.findLast((l) => l.at !== undefined)?.at ?? started;
  const quietMs = running ? now - lastAt : 0;
  const dur = (ms: number) => formatDuration(ms, t, locale);

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={styles.toggle}
        >
          <ChevronRight size={14} color={colors.subtle} style={open ? { transform: [{ rotate: "90deg" }] } : undefined} />
          <StatusIcon status={task.status} />
          <Text style={styles.title} numberOfLines={1}>
            {task.title}
          </Text>
          <Text style={styles.meta}>{task.harness}</Text>
        </Pressable>
        <Text style={styles.meta} accessibilityLabel={`${t("tasks.totalTime")}: ${dur(Math.max(0, total))}`}>
          {dur(Math.max(0, total))}
        </Text>
        {task.prUrl && <PullRequestLink url={task.prUrl} />}
        {running && (
          <Pressable
            accessibilityRole="button"
            disabled={stopping}
            hitSlop={6}
            onPress={async () => {
              setStopping(true);
              setStopError(null);
              try {
                await api.cancelTask(projectId, task.threadId, task.id);
              } catch (err) {
                setStopError(errorMessage(err, t("tasks.stopFailed")));
              } finally {
                setStopping(false);
              }
            }}
            style={[styles.action, stopping && { opacity: 0.5 }]}
          >
            <Square size={11} color={colors.muted} />
            <Text style={styles.stop}>{t("tasks.stop")}</Text>
          </Pressable>
        )}
      </View>
      {stopError && running && <Text style={[styles.note, { color: colors.bad }]}>{stopError}</Text>}
      {open && <Terminal lines={lines} end={task.finishedAt ? Date.parse(task.finishedAt) : now} />}
      {quietMs > QUIET_MS && <Text style={styles.note}>{t("tasks.quiet", { time: dur(quietMs) })}</Text>}
    </View>
  );
}

/** Past this long without a new line, a running task says it may be stuck. */
const QUIET_MS = 3 * 60_000;

/** The current time, ticking every second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * How long each line's step took: what the runner reported, or for a tool call reported when it
 * started, until the next tool call (or the end of the task).
 */
function stepTimes(lines: TerminalLine[], end: number): (number | undefined)[] {
  let next: number | undefined;
  const times: (number | undefined)[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.ms !== undefined) times[i] = l.ms;
    else if (l.tool && l.at !== undefined) times[i] = Math.max(0, (next ?? end) - l.at);
    if (l.tool && l.at !== undefined) next = l.at;
  }
  return times;
}

function Terminal({ lines, end }: { lines: TerminalLine[]; end: number }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const times = stepTimes(lines, end);
  return (
    <View accessibilityLabel={t("tasks.terminalOutput")} style={styles.terminal}>
      {lines.length === 0 && <Text style={[styles.out, { color: colors.subtle }]}>{t("tasks.waiting")}</Text>}
      {lines.map((l, i) => (
        <TerminalRow
          key={i}
          line={l}
          first={i === 0}
          time={times[i] === undefined ? undefined : formatDuration(times[i]!, t, locale)}
        />
      ))}
    </View>
  );
}

/** Past this many characters or lines, a step shows folded with a toggle. */
const FOLD_CHARS = 280;
const FOLD_LINES = 3;

/**
 * One terminal line. A command shows after a prompt, without the shell wrapper the CLI ran it in;
 * an agent's step or message reads as prose; output stays monospace under its command.
 */
function TerminalRow({ line, first, time }: { line: TerminalLine; first: boolean; time?: string }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const [open, setOpen] = useState(false);
  const step = line.tool ? line.text.replace(/^→ /, "") : null;
  const command = step?.startsWith("$ ") ? unwrapShell(step.slice(2)) : null;
  const text = command ?? step ?? line.text;
  const long = !!step && (text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES);
  const tone = line.stream === "stderr" ? colors.bad : step ? colors.fg : line.stream === "system" ? colors.subtle : colors.muted;
  return (
    <View style={[styles.line, step && !first ? { marginTop: 8 } : null]}>
      <Text style={[styles.out, styles.prompt, { color: command ? colors.accent : colors.subtle }]}>
        {command ? "$" : step ? "›" : " "}
      </Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={[step && !command ? styles.prose : styles.out, { color: tone }]}
          numberOfLines={long && !open ? FOLD_LINES : undefined}
        >
          {text}
        </Text>
        {long && (
          <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} hitSlop={6}>
            <Text style={styles.more}>{open ? t("tasks.showLess") : t("tasks.showMore")}</Text>
          </Pressable>
        )}
      </View>
      {time && <Text style={[styles.out, { color: colors.subtle }]}>{time}</Text>}
    </View>
  );
}

function StatusIcon({ status }: { status: Task["status"] }) {
  const colors = useColors();
  if (status === "running") return <Spinner size={14} color={colors.accent} />;
  if (status === "done") return <CircleCheck size={14} color={colors.ok} />;
  if (status === "cancelled") return <CircleSlash size={14} color={colors.subtle} />;
  return <CircleAlert size={14} color={colors.bad} />;
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    page: { padding: 16, gap: 14 },
    card: {
      gap: 8,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    head: { flexDirection: "row", alignItems: "center", gap: 8 },
    toggle: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    title: { flexShrink: 1, color: colors.fg, fontSize: 14, fontWeight: "600" },
    meta: { color: colors.subtle, fontSize: 12, fontVariant: ["tabular-nums"] },
    summary: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    action: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 },
    link: { color: colors.accent, fontSize: 12, fontWeight: "500" },
    stop: { color: colors.muted, fontSize: 12 },
    note: { color: colors.muted, fontSize: 12, paddingLeft: 22 },
    terminal: {
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.console,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    line: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    prompt: { width: 8 },
    out: { fontFamily: mono, fontSize: 11.5, lineHeight: 18, color: colors.muted },
    prose: { fontSize: 13, lineHeight: 19 },
    more: { color: colors.accent, fontSize: 12, marginTop: 2 },
  }),
);
