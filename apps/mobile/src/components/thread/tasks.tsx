import { newestFirst, type SubagentSummary, taskHeadline, taskSubagents } from "@myrel/client";
import { clockTime, dayLabel, localDay, relativeTime } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { type Task, type TerminalLine, unwrapShell } from "@myrel/protocol";
import {
  Bot,
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
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatDuration, formatTokens } from "../../lib/format";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Empty } from "../project/empty";
import { errorMessage, Spinner } from "../ui";

/**
 * Every task the thread's agent ran, newest first under a heading for its day. The running one and,
 * once all are done, the latest open by themselves; the rest stay folded.
 */
export function TerminalTab({ projectId, tasks, output }: { projectId: string; tasks: Task[]; output: Record<string, TerminalLine[]> }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  if (tasks.length === 0) {
    return (
      <Empty
        icon={<SquareTerminal size={22} color={colors.subtle} />}
        title={t("workspace.terminalEmpty")}
        body={t("workspace.terminalEmptyBody")}
      />
    );
  }
  const sorted = newestFirst(tasks);
  const days: { day: string; tasks: Task[] }[] = [];
  for (const task of sorted) {
    const day = localDay(task.createdAt);
    if (days.at(-1)?.day === day) days.at(-1)!.tasks.push(task);
    else days.push({ day, tasks: [task] });
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {days.map(({ day, tasks: dayTasks }, i) => (
        <View key={day} style={[styles.day, i > 0 && { marginTop: 8 }]}>
          <Text style={styles.dayLabel} accessibilityRole="header">
            {dayLabel(t, locale, dayTasks[0]!.createdAt)}
          </Text>
          {dayTasks.map((task) => (
            <TaskRow key={task.id} projectId={projectId} task={task} lines={output[task.id] ?? []} latest={task.id === sorted[0]!.id} />
          ))}
        </View>
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

function TaskRow({ projectId, task, lines, latest }: { projectId: string; task: Task; lines: TerminalLine[]; latest: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const { api } = useSession();
  const running = task.status === "running";
  const [open, setOpen] = useState(running || latest);
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
  const headline = taskHeadline(task.summary);
  const clock = clockTime(locale, task.createdAt);
  const subagents = useMemo(() => taskSubagents(lines, running), [lines, running]);
  // A subagent picked in the list: the terminal shows only its lines.
  const [focus, setFocus] = useState<string | null>(null);
  const focused = subagents.find((a) => a.id === focus);
  const shown = focused ? lines.filter((l) => l.agent?.id === focused.id) : lines;

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
        <Text
          style={styles.meta}
          accessibilityLabel={`${t("tasks.startedAt", { time: `${clock}, ${relativeTime(t, locale, task.createdAt)}` })}. ${t("tasks.totalTime")}: ${dur(Math.max(0, total))}`}
        >
          {clock} · {dur(Math.max(0, total))}
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
      {headline && (
        <Text style={styles.headline} numberOfLines={1}>
          {headline}
        </Text>
      )}
      {stopError && running && <Text style={[styles.note, { color: colors.bad }]}>{stopError}</Text>}
      {open && subagents.length > 0 && (
        <Subagents agents={subagents} focus={focused?.id ?? null} onFocus={(id) => setFocus(id === focus ? null : id)} now={now} />
      )}
      {open && focused && (
        <View style={styles.filter}>
          <Text style={styles.filterText}>{t("tasks.subagentFilter", { name: focused.label })}</Text>
          <Pressable accessibilityRole="button" onPress={() => setFocus(null)} hitSlop={6}>
            <Text style={styles.link}>{t("tasks.showAllLines")}</Text>
          </Pressable>
        </View>
      )}
      {open && <Terminal lines={shown} end={task.finishedAt ? Date.parse(task.finishedAt) : now} />}
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
 * started, until the next tool call of the same agent (subagents run alongside it) or the end of the task.
 */
function stepTimes(lines: TerminalLine[], end: number): (number | undefined)[] {
  const next = new Map<string, number>();
  const times: (number | undefined)[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const who = l.agent?.id ?? "";
    if (l.ms !== undefined) times[i] = l.ms;
    else if (l.tool && l.at !== undefined) times[i] = Math.max(0, (next.get(who) ?? end) - l.at);
    if (l.tool && l.at !== undefined) next.set(who, l.at);
  }
  return times;
}

function Terminal({ lines, end }: { lines: TerminalLine[]; end: number }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const times = stepTimes(lines, end);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Follows new output while the reader is at the bottom; scrolling up stops that.
  const pinned = useRef(true);
  return (
    <ScrollView
      ref={scroll}
      nestedScrollEnabled
      accessibilityLabel={t("tasks.terminalOutput")}
      style={styles.terminal}
      contentContainerStyle={styles.terminalBody}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        pinned.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 40;
      }}
      scrollEventThrottle={100}
      onContentSizeChange={() => pinned.current && scroll.current?.scrollToEnd({ animated: false })}
    >
      {lines.length === 0 && <Text style={[styles.out, { color: colors.subtle }]}>{t("tasks.waiting")}</Text>}
      {lines.map((l, i) => (
        <TerminalRow
          key={i}
          line={l}
          first={i === 0}
          time={times[i] === undefined ? undefined : formatDuration(times[i]!, t, locale)}
        />
      ))}
    </ScrollView>
  );
}

const SUBAGENT_STATUS = {
  running: "tasks.subagentStatusRunning",
  done: "tasks.subagentStatusDone",
  failed: "tasks.subagentStatusFailed",
  stopped: "tasks.subagentStatusStopped",
} as const;

/**
 * The task's subagents, one card each: what it is for, how it is doing and what it used. Picking
 * one opens it (its answer, or its latest step while it runs) and narrows the terminal to its lines.
 */
function Subagents({ agents, focus, onFocus, now }: { agents: SubagentSummary[]; focus: string | null; onFocus: (id: string) => void; now: number }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const running = agents.filter((a) => a.status === "running").length;
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.head}>
        <Bot size={13} color={colors.muted} />
        <Text style={styles.agentsTitle}>
          {t("tasks.subagents", { count: agents.length })}
          {running > 0 && <Text style={{ color: colors.accent, fontWeight: "400" }}> · {t("tasks.subagentsRunning", { count: running })}</Text>}
        </Text>
      </View>
      {agents.map((a) => {
        const open = a.id === focus;
        const ms = a.ms ?? (a.status === "running" && a.startedAt !== undefined ? Math.max(0, now - a.startedAt) : undefined);
        const meta = [
          a.model,
          ms !== undefined ? formatDuration(ms, t, locale) : null,
          a.steps ? t("tasks.subagentSteps", { count: a.steps }) : null,
          a.tokens ? t("tasks.subagentTokens", { count: formatTokens(a.tokens, locale) }) : null,
        ].filter(Boolean);
        const detail = a.status === "running" ? (a.lastStep ? t("tasks.subagentNow", { step: a.lastStep }) : "") : a.answer;
        return (
          <Pressable
            key={a.id}
            accessibilityRole="button"
            accessibilityState={{ selected: open }}
            accessibilityLabel={`${a.label}, ${t(SUBAGENT_STATUS[a.status])}. ${a.purpose}`}
            onPress={() => onFocus(a.id)}
            style={[styles.agent, open && { borderColor: colors.accentLine, backgroundColor: colors.accentSoft }]}
          >
            <View style={styles.head}>
              <SubagentStatus status={a.status} />
              <Text style={styles.agentName}>{a.label}</Text>
              <Text style={[styles.agentPurpose, !a.purpose && { fontStyle: "italic", color: colors.subtle }]} numberOfLines={open ? undefined : 1}>
                {a.purpose || t("tasks.subagentNoPurpose")}
              </Text>
            </View>
            {meta.length > 0 && <Text style={[styles.meta, { paddingLeft: 21 }]}>{meta.join(" · ")}</Text>}
            {open && !!detail && <Text style={styles.agentDetail}>{detail}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

function SubagentStatus({ status }: { status: SubagentSummary["status"] }) {
  const colors = useColors();
  if (status === "running") return <Spinner size={13} color={colors.accent} />;
  if (status === "done") return <CircleCheck size={13} color={colors.ok} />;
  if (status === "stopped") return <CircleSlash size={13} color={colors.subtle} />;
  return <CircleAlert size={13} color={colors.bad} />;
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
  if (line.agent?.state) return <AgentRow line={line} first={first} time={time} />;
  const agent = line.agent;
  const step = line.tool ? line.text.replace(/^→ /, "") : null;
  const command = step?.startsWith("$ ") ? unwrapShell(step.slice(2)) : null;
  const text = command ?? step ?? line.text;
  const long = !!step && (text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES);
  const tone = line.stream === "stderr" ? colors.bad : step ? colors.fg : line.stream === "system" ? colors.subtle : colors.muted;
  return (
    <View
      style={[styles.line, step && !first ? { marginTop: 8 } : null, agent ? styles.sub : null]}
      accessibilityLabel={agent && step ? `${t("tasks.agentStep", { name: agent.label })}: ${text}` : undefined}
    >
      <Text style={[styles.out, styles.prompt, { color: command ? colors.accent : colors.subtle }]}>
        {command ? "$" : step ? "›" : " "}
      </Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        {agent && step && <Text style={styles.agentLabel}>{agent.label}</Text>}
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

/** A subagent starting (with what it is for) or ending (with its answer, folded when long). */
function AgentRow({ line, first, time }: { line: TerminalLine; first: boolean; time?: string }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const [open, setOpen] = useState(false);
  const agent = line.agent!;
  const key = agent.state === "started" ? "tasks.agentStarted" : agent.state === "done" ? "tasks.agentDone" : "tasks.agentFailed";
  const text = line.text.trim();
  const long = text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
  const tone = agent.state === "failed" ? colors.bad : agent.state === "done" ? colors.ok : colors.accent;
  return (
    <View style={[styles.line, first ? null : { marginTop: 8 }]}>
      <View style={styles.agentIcon}>
        <Bot size={13} color={tone} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.prose, { color: agent.state === "failed" ? colors.bad : colors.fg, fontWeight: "500" }]}>
          {t(key, { name: agent.label })}
        </Text>
        {!!text && (
          <Text style={[styles.prose, { color: colors.muted }]} numberOfLines={long && !open ? FOLD_LINES : undefined}>
            {text}
          </Text>
        )}
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
      maxHeight: 420,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.console,
    },
    terminalBody: { paddingHorizontal: 10, paddingVertical: 8 },
    day: { gap: 14 },
    dayLabel: { color: colors.subtle, fontSize: 12, fontWeight: "500" },
    headline: { color: colors.muted, fontSize: 12.5, paddingLeft: 22 },
    line: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    prompt: { width: 8 },
    agentsTitle: { color: colors.muted, fontSize: 12, fontWeight: "500" },
    agent: {
      gap: 2,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    agentName: { color: colors.fg, fontSize: 13, fontWeight: "600" },
    agentPurpose: { flex: 1, minWidth: 0, color: colors.muted, fontSize: 13 },
    agentDetail: {
      marginTop: 4,
      paddingTop: 6,
      paddingLeft: 21,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      color: colors.fg,
      fontSize: 13,
      lineHeight: 19,
    },
    filter: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    filterText: { color: colors.muted, fontSize: 12 },
    sub: { marginLeft: 6, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: colors.line },
    agentLabel: { color: colors.accent, fontSize: 11, lineHeight: 15 },
    agentIcon: { width: 13, paddingTop: 3 },
    out: { fontFamily: mono, fontSize: 11.5, lineHeight: 18, color: colors.muted },
    prose: { fontSize: 13, lineHeight: 19 },
    more: { color: colors.accent, fontSize: 12, marginTop: 2 },
  }),
);
