import { useT } from "@myrel/i18n/react";
import { type CheckModel, cliLogins, effortsFor, type RunnerCli } from "@myrel/protocol";
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { makeStyles } from "../theme";
import { cliName, effortName, Option, Sheet } from "./cli-picker";
import { ValueRow } from "./settings-section";

/**
 * Who judges visual checks (CheckModel), as on the web: "automatic" or a CLI from `clis` with its
 * model, effort and login. One row; a tap opens a sheet, and each pick calls onChange (which saves).
 */
export function EvaluatorRow({
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
  const styles = useStyles();
  const [open, setOpen] = useState(false);
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
  const summary = value
    ? [
        cliName(value.cli),
        value.model ? (models.find((m) => m.id === value.model)?.name ?? value.model) : t("modelPicker.cliDefault"),
        value.effort && effortName(value.effort, t),
      ]
        .filter(Boolean)
        .join(" · ")
    : autoLabel;

  return (
    <>
      <ValueRow label={t("evaluator.title")} value={summary} onPress={disabled ? undefined : () => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title={t("evaluator.title")}>
        <ScrollView style={{ maxHeight: 520 }}>
          <Text style={styles.part}>{t("evaluator.cli")}</Text>
          <Option kind="radio" wrap checked={!value} title={autoLabel} onPress={() => onChange(null)} />
          {clis.map((c) => (
            <Option
              key={c.id}
              kind="radio"
              checked={value?.cli === c.id}
              title={cliName(c.id)}
              onPress={() => value?.cli !== c.id && onChange({ cli: c.id, model: null, effort: null, account: null })}
            />
          ))}
          {value && !installed && <Option kind="radio" checked title={value.cli} onPress={() => setOpen(false)} />}
          {value && installed && !!installed.accounts?.length && (
            <>
              <Text style={styles.part}>{t("projectSettings.cliAccount", { cli: cliName(installed.id) })}</Text>
              {cliLogins(installed).map((l) => (
                <Option
                  key={l.account ?? ""}
                  kind="radio"
                  checked={(value.account ?? null) === l.account}
                  title={l.name ?? t("cliPicker.ownLogin")}
                  onPress={() => set({ account: l.account })}
                />
              ))}
            </>
          )}
          {value && (
            <>
              <Text style={styles.part}>{t("evaluator.model")}</Text>
              {models.length === 0 ? (
                <Text style={styles.empty}>{t("evaluator.noModels")}</Text>
              ) : (
                <>
                  <Option kind="radio" checked={!value.model} title={t("modelPicker.cliDefault")} onPress={() => set({ model: null })} />
                  {models.map((m) => (
                    <Option key={m.id} kind="radio" checked={value.model === m.id} title={m.name} onPress={() => set({ model: m.id })} />
                  ))}
                </>
              )}
              <Text style={styles.part}>{t("modelPicker.effort")}</Text>
              {efforts.length > 0 ? (
                [null, ...efforts].map((e) => (
                  <Option
                    key={e ?? ""}
                    kind="radio"
                    checked={(value.effort ?? null) === e}
                    title={e ? effortName(e, t) : t("modelPicker.effortDefault")}
                    onPress={() => set({ effort: e })}
                  />
                ))
              ) : (
                <Text style={styles.empty}>{t("modelPicker.noEffort")}</Text>
              )}
            </>
          )}
        </ScrollView>
      </Sheet>
    </>
  );
}

/** The CLIs of several computers, once each: the first computer that runs a CLI speaks for it. */
export function mergeClis(lists: RunnerCli[][]): RunnerCli[] {
  const seen = new Map<string, RunnerCli>();
  for (const list of lists) for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    empty: { color: colors.subtle, fontSize: 13, lineHeight: 18, paddingVertical: 4 },
    part: { color: colors.subtle, fontSize: 13, fontWeight: "600", marginTop: 10, marginBottom: 2 },
  }),
);
