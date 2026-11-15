import { useT } from "@myrel/i18n/react";
import {
  cliLogins,
  COORDINATOR_CLIS,
  type CoordinatorCli,
  type CoordinatorInput,
  type CoordinatorSettings,
  effortsFor,
  type Runner,
} from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { membersQuery, runnersQuery, workspacesQuery } from "../lib/api";
import { cliName, effortName } from "./chat/cli-picker";
import { Field, Notice, Section, Select } from "./settings";

/** What the form holds; a CLI not picked yet is "". `account`: the CLI's login, null for its own. */
export type CoordinatorDraft =
  | { mode: "model" }
  | { mode: "cli"; runnerId: string; cli: CoordinatorCli | ""; model: string | null; effort: string | null; account: string | null };

export function coordinatorDraft(settings: CoordinatorSettings): CoordinatorDraft {
  if (settings.mode === "model") return { mode: "model" };
  const cli = (COORDINATOR_CLIS as readonly string[]).includes(settings.cli) ? (settings.cli as CoordinatorCli) : "";
  return { mode: "cli", runnerId: settings.runnerId, cli, model: settings.model, effort: settings.effort, account: settings.account };
}

/** The change to save, if the form holds one that can be saved. */
export function coordinatorChange(saved: CoordinatorSettings, draft: CoordinatorDraft): CoordinatorInput | undefined {
  if (JSON.stringify(coordinatorDraft(saved)) === JSON.stringify(draft)) return undefined;
  if (draft.mode === "model") return { mode: "model" };
  if (!draft.runnerId || !draft.cli) return undefined;
  return { ...draft, cli: draft.cli };
}

const coordinatorClis = (runner: Runner | undefined) => runner?.clis.filter((c) => (COORDINATOR_CLIS as readonly string[]).includes(c.id)) ?? [];

/**
 * How the coordinator works (ProjectSettings.coordinator): with the server's model, or with a CLI on one
 * of your own computers that has this project's folder. The computer, CLI, model and effort show only
 * while a CLI is picked, the CLI's login too when the computer has several (`myrel-runner claude add`),
 * and only the computer's owner changes them: others see whose computer it is and can switch it back to
 * the server's model. The lists of models, efforts and logins come from the CLI itself.
 */
export function CoordinatorSection({
  projectId,
  saved,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  saved: CoordinatorSettings;
  value: CoordinatorDraft;
  onChange: (next: CoordinatorDraft) => void;
  disabled: boolean;
}) {
  const t = useT();
  const { user } = useRouteContext({ from: "/_app" });
  const { data: runners = [] } = useQuery(runnersQuery);
  const { data: workspaces = [] } = useQuery(workspacesQuery(projectId));
  const elsewhere = saved.mode === "cli" && saved.by !== user.id ? saved : null;
  const { data: members = [] } = useQuery({ ...membersQuery(projectId), enabled: !!elsewhere });
  // Your own computers with this project's folder: only there can it work with your CLI.
  const mine = runners.filter((r) => workspaces.some((w) => w.runnerId === r.id));

  const pickComputer = (runnerId: string) => {
    const cli = coordinatorClis(runners.find((r) => r.id === runnerId))[0]?.id ?? "";
    onChange({ mode: "cli", runnerId, cli: cli as CoordinatorCli | "", model: null, effort: null, account: null });
  };
  const onMode = (mode: string) => {
    if (mode === "model") return onChange({ mode: "model" });
    // Back to what was saved when it was a CLI, else the first of your computers.
    const back = coordinatorDraft(saved);
    if (back.mode === "cli") return onChange(back);
    pickComputer(mine[0]?.id ?? "");
  };

  const draft = value.mode === "cli" ? value : null;
  const runner = draft ? runners.find((r) => r.id === draft.runnerId) : undefined;
  const onOther = !!draft && !!elsewhere && draft.runnerId === elsewhere.runnerId;
  const clis = coordinatorClis(runner);
  const cli = clis.find((c) => c.id === draft?.cli);
  const models = cli?.models ?? [];
  const efforts = effortsFor(models, draft?.model ?? null);
  // Whose subscription its turns use, when the computer has more than the CLI's own login.
  const accounts = cli?.accounts ?? [];
  const set = (patch: Partial<Extract<CoordinatorDraft, { mode: "cli" }>>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    // An effort the model does not take would be dropped when it runs: clear it here instead.
    if (next.effort && !effortsFor(models, next.model).includes(next.effort)) next.effort = null;
    onChange(next);
  };

  return (
    <Section title={t("coordinator.title")} description={t("coordinator.description")}>
      <Field label={t("coordinator.mode")}>
        <Select value={value.mode} disabled={disabled} onChange={(e) => onMode(e.target.value)}>
          <option value="model">{t("coordinator.modeModel")}</option>
          <option value="cli">{t("coordinator.modeCli")}</option>
        </Select>
      </Field>
      {draft && (
        <>
          {(mine.length > 0 || elsewhere) && (
            <Field label={t("coordinator.computer")}>
              <Select value={draft.runnerId} disabled={disabled} onChange={(e) => pickComputer(e.target.value)}>
                {elsewhere && !mine.some((r) => r.id === elsewhere.runnerId) && (
                  <option value={elsewhere.runnerId}>{elsewhere.computer}</option>
                )}
                {mine.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {onOther ? (
            <p className="text-[13px] text-muted">
              {t("coordinator.elsewhere", {
                cli: cliName(elsewhere.cli),
                computer: elsewhere.computer,
                person: members.find((m) => m.id === elsewhere.by)?.name ?? t("coordinator.someone"),
              })}
            </p>
          ) : mine.length === 0 ? (
            <Notice>{t("coordinator.noComputer")}</Notice>
          ) : !runner ? null : clis.length === 0 ? (
            <Notice>{t("coordinator.noCli", { computer: runner.name })}</Notice>
          ) : (
            <>
              <div className={`grid gap-3 ${accounts.length ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
                <Field label={t("coordinator.cli")}>
                  <Select
                    value={draft.cli}
                    disabled={disabled}
                    onChange={(e) => set({ cli: e.target.value as CoordinatorCli, model: null, effort: null, account: null })}
                  >
                    {clis.map((c) => (
                      <option key={c.id} value={c.id}>
                        {cliName(c.id)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {cli && accounts.length > 0 && (
                  <Field label={t("coordinator.account")} hint={t("coordinator.accountHint")}>
                    <Select value={draft.account ?? ""} disabled={disabled} onChange={(e) => set({ account: e.target.value || null })}>
                      {cliLogins(cli).map((l) => (
                        <option key={l.account ?? ""} value={l.account ?? ""}>
                          {l.name ?? t("cliPicker.ownLogin")}
                        </option>
                      ))}
                      {/* A login the computer no longer has stays visible until someone changes it; its turns run with the CLI's own. */}
                      {draft.account && !accounts.some((a) => a.id === draft.account) && <option value={draft.account}>{draft.account}</option>}
                    </Select>
                  </Field>
                )}
                <Field label={t("coordinator.model")}>
                  <Select value={draft.model ?? ""} disabled={disabled || models.length === 0} onChange={(e) => set({ model: e.target.value || null })}>
                    <option value="">{t("modelPicker.cliDefault")}</option>
                    {/* A model the CLI no longer lists stays visible until someone changes it. */}
                    {draft.model && !models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("modelPicker.effort")} hint={efforts.length === 0 ? t("modelPicker.noEffort") : undefined}>
                  <Select value={draft.effort ?? ""} disabled={disabled || efforts.length === 0} onChange={(e) => set({ effort: e.target.value || null })}>
                    <option value="">{t("modelPicker.effortDefault")}</option>
                    {efforts.map((e) => (
                      <option key={e} value={e}>
                        {effortName(e, t)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {!runner.features.includes("coordinator") && <Notice>{t("coordinator.oldRunner", { computer: runner.name })}</Notice>}
              <p className="text-[13px] text-subtle">{t("coordinator.cliHint", { computer: runner.name })}</p>
            </>
          )}
        </>
      )}
    </Section>
  );
}
