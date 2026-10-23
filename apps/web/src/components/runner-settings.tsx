import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { isNewerRunner, type Runner, type RunnerAccess, type RunnerSettingsInput } from "@myrel/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, runnersQuery } from "../lib/api";
import { Button, cn, errorMessage, GhostButton, Input } from "../lib/ui";
import { Command } from "./runners";
import { Switch } from "./ui/controls";

const ACCESS: { value: RunnerAccess; title: MessageKey; body: MessageKey }[] = [
  { value: "read", title: "runnerSettings.read", body: "runnerSettings.readBody" },
  { value: "edit", title: "runnerSettings.edit", body: "runnerSettings.editBody" },
  { value: "auto", title: "runnerSettings.auto", body: "runnerSettings.autoBody" },
  { value: "full", title: "runnerSettings.full", body: "runnerSettings.fullBody" },
];

/** Whether an update of this computer's runner is under way, so the list is refreshed often. */
export function updating(runner: Runner): boolean {
  return ["waiting", "downloading", "restarting"].includes(runner.update?.state ?? "");
}

function useRefreshRunners() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey });
}

/**
 * The runner's update, in one line under the computer's name: a button when a newer myrel-runner is
 * out and the runner can install it itself, how it goes once asked, and what to do where it cannot.
 */
export function RunnerUpdate({ runner, latest }: { runner: Runner; latest: string | null }) {
  const t = useT();
  const refresh = useRefreshRunners();
  const start = useMutation({ mutationFn: (now: boolean) => api.updateRunnerVersion(runner.id, now), onSuccess: refresh });
  const update = runner.update;
  const newer = Boolean(latest && runner.version && isNewerRunner(latest, runner.version));
  const canUpdate = runner.features.includes("update") && runner.updates === "service";

  let text: string | null = null;
  let tone: "info" | "busy" | "bad" = "info";
  let action: { label: string; now: boolean; primary?: boolean } | null = null;
  let command: string | null = null;
  let hint: string | null = null;

  if (update && update.state !== "failed" && update.state !== "rolled-back") {
    tone = "busy";
    if (update.state === "waiting") {
      text = update.running
        ? t("runnerUpdate.waiting", { count: update.running, version: update.version })
        : t("runnerUpdate.starting", { version: update.version });
      if (update.running && runner.online) {
        action = { label: t("runnerUpdate.now"), now: true };
        hint = t("runnerUpdate.nowHint");
      }
    } else {
      text = t(update.state === "downloading" ? "runnerUpdate.downloading" : "runnerUpdate.restarting", { version: update.version });
    }
  } else if (update && newer) {
    tone = "bad";
    text =
      update.state === "rolled-back"
        ? t("runnerUpdate.rolledBack", { version: update.version, message: update.message ?? "" })
        : t("runnerUpdate.failed", { version: update.version, message: update.message ?? "" });
    if (runner.online && canUpdate) action = { label: t("runnerUpdate.retry"), now: false };
  } else if (newer) {
    text = t("runnerUpdate.available", { version: latest! });
    if (runner.updates === "app") {
      hint = t("runnerUpdate.app");
    } else if (!runner.online) {
      hint = t("runnerUpdate.offline");
    } else if (canUpdate) {
      action = { label: t("runnerUpdate.update"), now: false, primary: true };
    } else if (runner.updates === "manual") {
      hint = t("runnerUpdate.manual");
      command = "npx myrel-runner@latest start";
    } else {
      hint = t("runnerUpdate.once");
      command = "npx myrel-runner@latest update";
    }
  }
  if (!text) return null;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
        tone === "bad" ? "border-bad-line bg-bad-soft" : "border-edge bg-panel",
      )}
      role="status"
    >
      <div className="flex items-center gap-2.5">
        {tone === "busy" ? (
          <LoaderCircle size={15} className="flex-none animate-spin text-accent motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <ArrowUpCircle size={15} className={cn("flex-none", tone === "bad" ? "text-bad" : "text-accent")} aria-hidden="true" />
        )}
        <span className={cn("min-w-0 flex-1 text-[13px]", tone === "bad" ? "text-bad" : "text-fg")}>{text}</span>
        {action &&
          (action.primary ? (
            <Button type="button" className="h-8 px-3 text-[13px]" disabled={start.isPending} onClick={() => start.mutate(action.now)}>
              {action.label}
            </Button>
          ) : (
            <GhostButton type="button" className="h-8 px-2.5 text-xs" disabled={start.isPending} onClick={() => start.mutate(action.now)}>
              {action.label}
            </GhostButton>
          ))}
      </div>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      {command && <Command>{command}</Command>}
      {start.error && <p className="text-xs text-bad">{errorMessage(start.error, t)}</p>}
    </div>
  );
}

/** The runner's settings, changed on the computer as soon as they are picked. */
export function RunnerSettingsPanel({ runner }: { runner: Runner }) {
  const t = useT();
  const refresh = useRefreshRunners();
  const [askFull, setAskFull] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(runner.name);
  useEffect(() => setName(runner.name), [runner.name]);

  const save = useMutation({
    mutationFn: (input: { name?: string; settings?: RunnerSettingsInput }) => api.updateRunner(runner.id, input),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return refresh();
    },
  });

  const settings = runner.settings;
  const supported = runner.features.includes("settings") && settings;
  const editable = Boolean(supported && runner.online && settings.remote);
  const why = !supported
    ? t("runnerSettings.old")
    : !runner.online
      ? t("runnerSettings.offline")
      : !settings.remote
        ? t("runnerSettings.remoteOff")
        : null;
  const pick = (access: RunnerAccess) => {
    if (access === settings?.access) return;
    if (access === "full") return setAskFull(true);
    setAskFull(false);
    save.mutate({ settings: { access } });
  };
  const renamed = name.trim() && name.trim() !== runner.name;

  return (
    <div className="flex flex-col gap-5 border-y border-line py-4">
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (renamed) save.mutate({ name: name.trim() });
        }}
      >
        <label htmlFor={`runner-name-${runner.id}`} className="text-[13px] font-medium">
          {t("runnerSettings.name")}
        </label>
        <div className="flex gap-2">
          <Input id={`runner-name-${runner.id}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="h-9 flex-1" />
          {renamed && (
            <GhostButton type="submit" disabled={save.isPending}>
              {t("runnerSettings.rename")}
            </GhostButton>
          )}
        </div>
        <p className="text-xs text-subtle">{t("runnerSettings.nameBody")}</p>
      </form>

      {why && (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-edge px-3 py-2.5">
          <p className="text-[13px] text-muted">{why}</p>
          {supported && !settings.remote && <Command>npx myrel-runner settings remote on</Command>}
          {!supported && runner.updates !== "app" && <Command>npx myrel-runner@latest update</Command>}
        </div>
      )}

      {settings && (
        <fieldset className="flex flex-col gap-2" disabled={!editable || save.isPending}>
          <legend className="mb-2 text-[13px] font-medium">{t("runnerSettings.access")}</legend>
          <div className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-edge" role="radiogroup">
            {ACCESS.map((a) => {
              const checked = settings.access === a.value;
              return (
                <label
                  key={a.value}
                  className={cn(
                    "flex cursor-pointer gap-3 px-3.5 py-3 has-[:disabled]:cursor-default",
                    checked ? "bg-accent-soft" : "bg-panel hover:bg-hover",
                  )}
                >
                  <input
                    type="radio"
                    name={`access-${runner.id}`}
                    value={a.value}
                    checked={checked}
                    onChange={() => pick(a.value)}
                    className="mt-0.5 size-4 flex-none accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      {t(a.title)}
                      {a.value === "auto" && (
                        <span className="rounded-md border border-edge px-1.5 py-px text-[11px] font-normal text-muted">
                          {t("runnerSettings.recommended")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-subtle">{t(a.body)}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {askFull && (
            <div className="flex flex-col gap-2.5 rounded-lg border border-bad-line bg-bad-soft px-3.5 py-3">
              <p className="text-[13px] text-fg">{t("runnerSettings.fullConfirm", { name: runner.name })}</p>
              <div className="flex gap-2">
                <GhostButton
                  type="button"
                  className="border-bad-line text-bad hover:bg-bad-hover"
                  onClick={() => {
                    setAskFull(false);
                    save.mutate({ settings: { access: "full" } });
                  }}
                >
                  {t("runnerSettings.fullConfirmYes")}
                </GhostButton>
                <GhostButton type="button" onClick={() => setAskFull(false)}>
                  {t("devices.cancel")}
                </GhostButton>
              </div>
            </div>
          )}
        </fieldset>
      )}

      {settings && (
        <div className="flex flex-col divide-y divide-line">
          <Toggle
            title={t("runnerSettings.worktrees")}
            body={t("runnerSettings.worktreesBody")}
            checked={settings.worktrees}
            disabled={!editable || save.isPending}
            onChange={(on) => save.mutate({ settings: { worktrees: on } })}
          />
          <Toggle
            title={t("runnerSettings.autoUpdate")}
            body={runner.updates === "service" ? t("runnerSettings.autoUpdateBody") : t("runnerSettings.autoUpdateUnavailable")}
            checked={settings.autoUpdate && runner.updates === "service"}
            disabled={!editable || save.isPending || runner.updates !== "service"}
            onChange={(on) => save.mutate({ settings: { autoUpdate: on } })}
          />
        </div>
      )}

      <div className="flex min-h-5 items-center gap-2 text-xs">
        {save.isPending ? (
          <span className="flex items-center gap-1.5 text-subtle">
            <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t("runnerSettings.saving")}
          </span>
        ) : save.error ? (
          <span className="text-bad">{errorMessage(save.error, t)}</span>
        ) : saved ? (
          <span className="flex items-center gap-1.5 text-ok">
            <Check size={13} aria-hidden="true" />
            {t("runnerSettings.saved")}
          </span>
        ) : (
          editable &&
          runner.updates !== "app" && (
            <span className="text-subtle">
              {t("runnerSettings.remoteHint")} <code className="font-mono text-[11.5px] text-muted">myrel-runner settings remote off</code>
            </span>
          )
        )}
      </div>
    </div>
  );
}

function Toggle(props: { title: string; body: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{props.title}</span>
        <span className="mt-0.5 block text-xs text-subtle">{props.body}</span>
      </span>
      <Switch checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
    </label>
  );
}
