import { useT } from "@myrel/i18n/react";
import { type CheckModels, type CliId, cliLogins, effortsFor, type RunnerCli } from "@myrel/protocol";
import { cliName, effortName } from "./chat/cli-picker";
import { Field, Select } from "./settings";
import { Checkbox } from "./ui/controls";

/**
 * The CLIs that may judge visual checks (CheckModels): one row per CLI in `clis`, ticked to let it
 * judge, with the model, effort and login it judges with (each defaulting to the CLI's own). Myrel
 * picks one of the ticked CLIs for each round, preferring one other than the CLI that made the change.
 * Used for a project (its computer's CLIs) and for a person's account (the CLIs of their computers).
 */
export function EvaluatorPicker({
  clis,
  value,
  onChange,
  disabled,
}: {
  clis: RunnerCli[];
  value: CheckModels;
  onChange: (next: CheckModels) => void;
  disabled: boolean;
}) {
  const t = useT();
  const set = (cli: CliId, patch: Partial<NonNullable<CheckModels[CliId]>> | null) => {
    const next: CheckModels = { ...value };
    if (!patch) delete next[cli];
    else {
      const models = clis.find((c) => c.id === cli)?.models ?? [];
      const merged = { model: null, effort: null, ...next[cli], ...patch };
      // An effort the model does not take would be dropped when it runs: clear it here instead.
      if (merged.effort && !effortsFor(models, merged.model).includes(merged.effort)) merged.effort = null;
      next[cli] = merged;
    }
    onChange(next);
  };
  // A CLI listed earlier that no computer here runs any more stays visible until someone unticks it.
  const gone = (Object.keys(value) as CliId[]).filter((id) => !clis.some((c) => c.id === id));
  return (
    <div className="space-y-3">
      {clis.map((c) => {
        const own = value[c.id];
        const models = c.models ?? [];
        const efforts = own ? effortsFor(models, own.model) : [];
        return (
          <div key={c.id} className="rounded-lg border border-edge px-3 py-2.5">
            <label className="flex items-center gap-2.5 text-[13px] font-medium">
              <Checkbox checked={!!own} disabled={disabled} onChange={(e) => set(c.id, e.target.checked ? {} : null)} />
              {cliName(c.id)}
            </label>
            {own && (
              <div className="mt-2.5 grid gap-3 sm:grid-cols-3">
                <Field label={t("evaluator.model")} hint={models.length === 0 ? t("evaluator.noModels") : undefined}>
                  <Select value={own.model ?? ""} disabled={disabled || models.length === 0} onChange={(e) => set(c.id, { model: e.target.value || null })}>
                    <option value="">{t("modelPicker.cliDefault")}</option>
                    {own.model && !models.some((m) => m.id === own.model) && <option value={own.model}>{own.model}</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("modelPicker.effort")} hint={efforts.length === 0 ? t("modelPicker.noEffort") : undefined}>
                  <Select value={own.effort ?? ""} disabled={disabled || efforts.length === 0} onChange={(e) => set(c.id, { effort: e.target.value || null })}>
                    <option value="">{t("modelPicker.effortDefault")}</option>
                    {efforts.map((e) => (
                      <option key={e} value={e}>
                        {effortName(e, t)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {!!c.accounts?.length && (
                  <Field label={t("projectSettings.cliAccount", { cli: cliName(c.id) })}>
                    <Select value={own.account ?? ""} disabled={disabled} onChange={(e) => set(c.id, { account: e.target.value || null })}>
                      {cliLogins(c).map((l) => (
                        <option key={l.account ?? ""} value={l.account ?? ""}>
                          {l.name ?? t("cliPicker.ownLogin")}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </div>
            )}
          </div>
        );
      })}
      {gone.map((id) => (
        <label key={id} className="flex items-center gap-2.5 rounded-lg border border-edge px-3 py-2.5 text-[13px] text-subtle">
          <Checkbox checked disabled={disabled} onChange={() => set(id, null)} />
          {cliName(id)} · {t("evaluator.notHere")}
        </label>
      ))}
    </div>
  );
}

/** The CLIs of several computers, once each: the first computer that runs a CLI speaks for it. */
export function mergeClis(lists: RunnerCli[][]): RunnerCli[] {
  const seen = new Map<string, RunnerCli>();
  for (const list of lists) for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}
