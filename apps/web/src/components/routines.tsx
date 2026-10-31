import type { Translate } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { Routine, RoutineScheduleInput, Thread, UpdateRoutineInputRaw } from "@myrel/protocol";
import { nextCronRun, routineFinished } from "@myrel/protocol";
import { AlarmClock, ChevronDown, Pause, Pencil, Play, Plus, Trash2, X, Zap } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useFormat } from "../lib/format";
import { Button, cn, errorMessage, GhostButton, IconButton, Input } from "../lib/ui";
import { useConfirm } from "./ui/confirm";
import { ThreadPicker } from "./thread-picker";
import { Select } from "./ui/controls";

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Header button with the project's routine count, opening the routines panel. */
export function RoutinesButton({ onClick, count, className }: { onClick: () => void; count: number; className: string }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("routines.title")}
      title={t("routines.title")}
      className={`${className} relative`}
    >
      <AlarmClock size={16} />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-raised px-1 text-center font-mono text-[10px] leading-4 text-muted">
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * Lists, creates, edits, pauses, runs and deletes a project's routines. Live state comes from the project
 * socket. One-off routines that have run are archived: kept out of the main list, under a fold at the end.
 */
export function RoutinesPanel({
  projectId,
  routines,
  threads,
  onClose,
}: {
  projectId: string;
  routines: Routine[];
  threads: Thread[];
  onClose: () => void;
}) {
  const t = useT();
  const format = useFormat();
  const active = routines.filter((r) => !routineFinished(r));
  const archived = routines.filter(routineFinished);
  const [creating, setCreating] = useState(active.length === 0);
  // The routine whose card is open as an edit form, in place of its card.
  const [editing, setEditing] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titles = useMemo(() => Object.fromEntries(threads.map((t) => [t.id, t.title])), [threads]);

  const confirm = useConfirm();

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  /** A routine's card, or its edit form while it is being edited. Archived cards cannot be paused. */
  function card(r: Routine, finished = false) {
    if (editing === r.id) {
      return (
        <li key={r.id}>
          <RoutineForm
            routine={r}
            threads={threads}
            className="space-y-3 rounded-xl border border-edge bg-ground p-4"
            onCancel={() => setEditing(null)}
            onSave={async (_, patch) => {
              if (Object.keys(patch).length) await api.updateRoutine(projectId, r.id, patch);
              setEditing(null);
            }}
          />
        </li>
      );
    }
    return (
      <li key={r.id} className="rounded-xl border border-line bg-raised p-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[13px] font-medium ${r.paused || finished ? "text-muted" : "text-fg"}`}>{r.name}</p>
            <p className="mt-0.5 text-xs text-subtle">
              {describeSchedule(r, t, format)} ·{" "}
              {r.target.kind === "thread"
                ? t("routines.inThread", { title: titles[r.target.threadId] ?? t("routines.aThread") })
                : t("routines.inChat")}
            </p>
          </div>
          <IconButton
            type="button"
            className="size-7"
            title={t("routines.edit")}
            aria-label={`${t("routines.edit")}: ${r.name}`}
            onClick={() => {
              setCreating(false);
              setEditing(r.id);
            }}
          >
            <Pencil size={14} />
          </IconButton>
          <IconButton
            type="button"
            className="size-7"
            title={t("routines.runNow")}
            aria-label={`${t("routines.runNow")}: ${r.name}`}
            onClick={() => act(() => api.runRoutine(projectId, r.id))}
          >
            <Zap size={14} />
          </IconButton>
          {!finished && (
            <IconButton
              type="button"
              className="size-7"
              title={r.paused ? t("routines.resume") : t("routines.pause")}
              aria-label={`${r.paused ? t("routines.resume") : t("routines.pause")}: ${r.name}`}
              onClick={() => act(() => api.updateRoutine(projectId, r.id, { paused: !r.paused }))}
            >
              {r.paused ? <Play size={14} /> : <Pause size={14} />}
            </IconButton>
          )}
          <IconButton
            type="button"
            className="size-7 hover:text-bad"
            title={t("routines.delete")}
            aria-label={`${t("routines.delete")}: ${r.name}`}
            onClick={async () => {
              const ok = await confirm({ title: t("routines.confirmDelete", { name: r.name }), action: t("routines.delete"), danger: true });
              if (ok) await act(() => api.deleteRoutine(projectId, r.id));
            }}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-muted">{r.prompt}</p>
        <p className="mt-2 text-[11px] text-subtle">
          {r.paused
            ? t("routines.paused")
            : r.nextRunAt
              ? t("routines.nextRun", { date: format.dateTime(r.nextRunAt), relative: format.relative(r.nextRunAt) })
              : t("routines.finished")}
          {r.lastRunAt && ` · ${t("routines.lastRan", { relative: format.relative(r.lastRunAt) })}`}
        </p>
      </li>
    );
  }

  // A portal, so no transformed ancestor can trap the fixed overlay inside it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <aside
        aria-label={t("routines.title")}
        className="flex h-full w-full max-w-[460px] flex-col border-l border-line bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-14 flex-none items-center gap-2.5 border-b border-line px-4">
          <AlarmClock size={17} className="text-muted" aria-hidden="true" />
          <h2 className="flex-1 text-[15px] font-semibold">{t("routines.title")}</h2>
          {!creating && (
            <GhostButton
              type="button"
              onClick={() => {
                setEditing(null);
                setCreating(true);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t("routines.new")}
            </GhostButton>
          )}
          <IconButton type="button" onClick={onClose} aria-label={t("routines.close")}>
            <X size={17} />
          </IconButton>
        </header>

        <div className="flex-1 overflow-y-auto">
          <p className="px-4 pt-4 text-xs text-subtle">{t("routines.intro")}</p>
          {creating && (
            <RoutineForm
              threads={threads}
              onCancel={routines.length ? () => setCreating(false) : undefined}
              onSave={async (input) => {
                await api.createRoutine(projectId, input);
                setCreating(false);
              }}
            />
          )}
          {error && <p className="px-4 pt-3 text-xs text-bad">{error}</p>}
          {!creating && active.length === 0 && <p className="px-4 pt-3 text-xs text-subtle">{t("routines.noActive")}</p>}
          <ul className="space-y-2 p-4">
            {active.map((r) => card(r))}
          </ul>
          {archived.length > 0 && (
            <section className="border-t border-line px-4 pb-4" aria-label={t("routines.archive", { count: archived.length })}>
              <button
                type="button"
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen((o) => !o)}
                className="flex h-10 w-full items-center gap-1.5 text-xs text-muted hover:text-fg"
              >
                <ChevronDown size={14} className={cn("transition-transform", !archiveOpen && "-rotate-90")} aria-hidden="true" />
                {t("routines.archive", { count: archived.length })}
              </button>
              {archiveOpen && (
                <>
                  <p className="pb-3 text-xs text-subtle">{t("routines.archiveHint")}</p>
                  <ul className="space-y-2">{archived.map((r) => card(r, true))}</ul>
                </>
              )}
            </section>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

type Repeat = "daily" | "weekdays" | "weekly" | "hourly" | "custom" | "once";

type RoutineDraft = {
  name: string;
  prompt: string;
  target: Routine["target"];
  schedule: RoutineScheduleInput;
};

/**
 * Creates a routine, or edits one when `routine` is given: its fields start from the routine's values
 * and saving sends only what changed (a new schedule may switch between repeating and once).
 */
function RoutineForm({
  routine,
  threads,
  onSave,
  onCancel,
  className = "m-4 space-y-3 rounded-xl border border-edge bg-ground p-4",
}: {
  routine?: Routine;
  threads: Thread[];
  /** draft: every field, for creating. patch: only the fields that differ from `routine`, for an edit. */
  onSave: (draft: RoutineDraft, patch: UpdateRoutineInputRaw) => Promise<void>;
  onCancel?: () => void;
  className?: string;
}) {
  const t = useT();
  const format = useFormat();
  const [initial] = useState(() => scheduleFields(routine?.schedule));
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [repeat, setRepeat] = useState<Repeat>(initial.repeat);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [cron, setCron] = useState(initial.cron);
  const [at, setAt] = useState(initial.at);
  const [target, setTarget] = useState(routine?.target.kind === "thread" ? routine.target.threadId : "");
  // An edit keeps its schedule (and time zone) until someone touches the schedule fields.
  const [scheduleTouched, setScheduleTouched] = useState(!routine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setScheduleTouched(true);
  };

  const schedule = scheduleTouched ? buildSchedule({ repeat, time, weekday, cron, at, timezone: initial.timezone }) : null;
  const preview = scheduleTouched ? previewNext(schedule) : routine!.nextRunAt;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (scheduleTouched && !schedule) return setError(t("routines.pickTime"));
    const draft: RoutineDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      target: target ? { kind: "thread", threadId: target } : { kind: "coordinator" },
      schedule: schedule ?? routine!.schedule,
    };
    setBusy(true);
    setError(null);
    try {
      const patch: UpdateRoutineInputRaw = {};
      if (routine) {
        if (draft.name !== routine.name) patch.name = draft.name;
        if (draft.prompt !== routine.prompt) patch.prompt = draft.prompt;
        if (JSON.stringify(draft.target) !== JSON.stringify(routine.target)) patch.target = draft.target;
        if (schedule && JSON.stringify(schedule) !== JSON.stringify(routine.schedule)) patch.schedule = schedule;
      }
      await onSave(draft, patch);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const select = "h-9 rounded-lg border border-edge bg-raised px-2.5 text-sm text-fg outline-none focus:border-accent";
  return (
    <form onSubmit={submit} className={className} aria-label={routine ? t("routines.editTitle", { name: routine.name }) : undefined}>
      <Input
        placeholder={t("routines.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={120}
      />
      <textarea
        placeholder={t("routines.promptPlaceholder")}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        required
        rows={3}
        maxLength={8000}
        className="w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label={t("routines.repeat")}
          className="w-auto"
          value={repeat}
          onChange={(e) => touch(setRepeat)(e.target.value as Repeat)}
        >
          <option value="weekdays">{t("routines.repeatWeekdays")}</option>
          <option value="daily">{t("routines.repeatDaily")}</option>
          <option value="weekly">{t("routines.repeatWeekly")}</option>
          <option value="hourly">{t("routines.repeatHourly")}</option>
          <option value="once">{t("routines.repeatOnce")}</option>
          <option value="custom">{t("routines.repeatCustom")}</option>
        </Select>
        {repeat === "weekly" && (
          <Select
            aria-label={t("routines.day")}
            className="w-auto"
            value={weekday}
            onChange={(e) => touch(setWeekday)(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <option key={d} value={d}>
                {format.weekday(d)}
              </option>
            ))}
          </Select>
        )}
        {(repeat === "daily" || repeat === "weekdays" || repeat === "weekly") && (
          <input
            aria-label={t("routines.time")}
            type="time"
            className={select}
            value={time}
            onChange={(e) => touch(setTime)(e.target.value)}
            required
          />
        )}
        {repeat === "once" && (
          <input
            aria-label={t("routines.dateTime")}
            type="datetime-local"
            className={select}
            value={at}
            onChange={(e) => touch(setAt)(e.target.value)}
            required
          />
        )}
        {repeat === "custom" && (
          <Input
            aria-label={t("routines.cron")}
            className="w-44 font-mono"
            value={cron}
            onChange={(e) => touch(setCron)(e.target.value)}
          />
        )}
      </div>
      <ThreadPicker threads={threads} value={target} onChange={setTarget} label={t("routines.where")} />
      <p className="text-[11px] text-subtle">
        {routine && !scheduleTouched
          ? routine.paused
            ? t("routines.paused")
            : preview
              ? t("routines.nextRun", { date: format.dateTime(preview), relative: format.relative(preview) })
              : t("routines.finished")
          : preview
            ? t(routine ? "routines.nextRunZone" : "routines.firstRun", { date: format.dateTime(preview), zone: initial.timezone })
            : t("routines.never")}
      </p>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <GhostButton type="button" onClick={onCancel}>
            {t("routines.cancel")}
          </GhostButton>
        )}
        <Button type="submit" disabled={busy || (scheduleTouched && !preview)}>
          {routine ? t("routines.save") : t("routines.create")}
        </Button>
      </div>
    </form>
  );
}

/** The form fields a schedule maps to; presets when the cron is one of them, else the raw cron. */
function scheduleFields(s: Routine["schedule"] | undefined): {
  repeat: Repeat;
  time: string;
  weekday: number;
  cron: string;
  at: string;
  timezone: string;
} {
  const fields = { repeat: "weekdays" as Repeat, time: "09:00", weekday: 1, cron: "0 9 * * 1-5", at: "", timezone: localZone };
  if (!s) return fields;
  if (s.kind === "once") return { ...fields, repeat: "once", at: toLocalInput(s.at) };
  fields.timezone = s.timezone;
  fields.cron = s.cron;
  const [min, hour, dom, mon, dow] = s.cron.split(/\s+/);
  if (s.cron === "0 * * * *") return { ...fields, repeat: "hourly" };
  const simple = /^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === "*" && mon === "*";
  if (!simple) return { ...fields, repeat: "custom" };
  const time = `${hour!.padStart(2, "0")}:${min!.padStart(2, "0")}`;
  if (dow === "*") return { ...fields, repeat: "daily", time };
  if (dow === "1-5") return { ...fields, repeat: "weekdays", time };
  if (/^[0-7]$/.test(dow!)) return { ...fields, repeat: "weekly", time, weekday: Number(dow) % 7 };
  return { ...fields, repeat: "custom" };
}

/** An ISO time as a datetime-local value (this device's wall clock, to the minute). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildSchedule(f: {
  repeat: Repeat;
  time: string;
  weekday: number;
  cron: string;
  at: string;
  timezone: string;
}): RoutineScheduleInput | null {
  const [h, m] = f.time.split(":").map(Number);
  const hm = Number.isInteger(h) && Number.isInteger(m) ? `${m} ${h}` : null;
  const cron = (expr: string | null) => (expr ? { kind: "cron" as const, cron: expr, timezone: f.timezone } : null);
  switch (f.repeat) {
    case "daily":
      return cron(hm && `${hm} * * *`);
    case "weekdays":
      return cron(hm && `${hm} * * 1-5`);
    case "weekly":
      return cron(hm && `${hm} * * ${f.weekday}`);
    case "hourly":
      return cron("0 * * * *");
    case "custom":
      return cron(f.cron.trim() || null);
    case "once": {
      const d = new Date(f.at);
      return Number.isNaN(d.getTime()) ? null : { kind: "once", at: d.toISOString() };
    }
  }
}

function previewNext(s: RoutineScheduleInput | null): string | null {
  if (!s) return null;
  if (s.kind === "once") return Date.parse(s.at) > Date.now() ? s.at : null;
  try {
    return nextCronRun(s.cron, s.timezone ?? "UTC", new Date())?.toISOString() ?? null;
  } catch {
    return null;
  }
}

function describeSchedule(r: Routine, t: Translate, format: ReturnType<typeof useFormat>): string {
  const s = r.schedule;
  if (s.kind === "once") return t("routines.once", { date: format.dateTime(s.at) });
  const [min, hour, dom, mon, dow] = s.cron.split(/\s+/);
  const simple = /^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === "*" && mon === "*";
  const at = simple ? `${hour!.padStart(2, "0")}:${min!.padStart(2, "0")}` : null;
  const zone = s.timezone === localZone ? "" : ` (${s.timezone})`;
  if (at && dow === "*") return t("routines.everyDay", { time: at }) + zone;
  if (at && dow === "1-5") return t("routines.weekdays", { time: at }) + zone;
  if (at && /^[0-7]$/.test(dow!)) return t("routines.everyWeekday", { day: format.weekday(Number(dow)), time: at }) + zone;
  if (s.cron === "0 * * * *") return t("routines.everyHour");
  return t("routines.cronSchedule", { cron: s.cron }) + zone;
}
