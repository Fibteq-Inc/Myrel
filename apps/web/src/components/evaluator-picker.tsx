import { useT } from "@myrel/i18n/react";
import { type CheckModel, cliLogins, effortsFor, type RunnerCli } from "@myrel/protocol";
import { cliName, effortName } from "./chat/cli-picker";
import { Field, Select } from "./settings";

/**
 * Who judges visual checks (CheckModel): "automatic" (another CLI than the one that made the change)
 * or a CLI from `clis` with its model, effort and login, each defaulting to the CLI's own. Used for
 * a project (its computer's CLIs) and for a person's account (the CLIs of their computers).
 */
export function EvaluatorPicker({
  clis,
  value,
  onChange,
  disabled,
  autoLabel,
}: {
  clis: RunnerCli[];
  value: CheckModel | null;
  onChange: (next: CheckModel | null) => void;
  disabled: boolean;
  autoLabel: string;
}) {
  const t = useT();
  const installed = value ? clis.find((c) => c.id === value.cli) : undefined;
  const models = installed?.models ?? [];
  const efforts = value ? effortsFor(models, value.model) : [];
  const set = (patch: Partial<CheckModel>) => {
    if (!value) return;
    const next = { ...value, ...patch };
    // An effort the model does not take would be dropped when it runs: clear it here instead.
    if (next.effort && !effortsFor(models, next.model).includes(next.effort)) next.effort = null;
    onChange(next);
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t("evaluator.cli")}>
        <Select
          value={value?.cli ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value ? { cli: e.target.value, model: null, effort: null, account: null } : null)}
        >
          <option value="">{autoLabel}</option>
          {clis.map((c) => (
            <option key={c.id} value={c.id}>
              {cliName(c.id)}
            </option>
          ))}
          {/* A choice no computer here runs any more stays visible until someone changes it. */}
          {value && !installed && <option value={value.cli}>{value.cli}</option>}
        </Select>
      </Field>
      {value && (
        <Field label={t("evaluator.model")} hint={models.length === 0 ? t("evaluator.noModels") : undefined}>
          <Select value={value.model ?? ""} disabled={disabled || models.length === 0} onChange={(e) => set({ model: e.target.value || null })}>
            <option value="">{t("modelPicker.cliDefault")}</option>
            {value.model && !models.some((m) => m.id === value.model) && <option value={value.model}>{value.model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value && (
        <Field label={t("modelPicker.effort")} hint={efforts.length === 0 ? t("modelPicker.noEffort") : undefined}>
          <Select value={value.effort ?? ""} disabled={disabled || efforts.length === 0} onChange={(e) => set({ effort: e.target.value || null })}>
            <option value="">{t("modelPicker.effortDefault")}</option>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {effortName(e, t)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value && installed && !!installed.accounts?.length && (
        <Field label={t("projectSettings.cliAccount", { cli: cliName(installed.id) })}>
          <Select value={value.account ?? ""} disabled={disabled} onChange={(e) => set({ account: e.target.value || null })}>
            {cliLogins(installed).map((l) => (
              <option key={l.account ?? ""} value={l.account ?? ""}>
                {l.name ?? t("cliPicker.ownLogin")}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  );
}

/** The CLIs of several computers, once each: the first computer that runs a CLI speaks for it. */
export function mergeClis(lists: RunnerCli[][]): RunnerCli[] {
  const seen = new Map<string, RunnerCli>();
  for (const list of lists) for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}
