import { useT } from "@myrel/i18n/react";
import { type CheckModels, type CliId, cliLogins, effortsFor, type RunnerCli } from "@myrel/protocol";
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { makeStyles } from "../theme";
import { cliName, effortName, Option, Sheet } from "./cli-picker";
import { ValueRow } from "./settings-section";

/**
 * The CLIs that may judge visual checks (CheckModels), as on the web: one row per CLI in `clis`; a
 * tap opens a sheet to let it judge or not, with the model, effort and login it judges with. Each
 * pick calls onChange (which saves).
 */
export function EvaluatorList({
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
  const styles = useStyles();
  const [open, setOpen] = useState<CliId | null>(null);
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
  const openCli = open ? clis.find((c) => c.id === open) : undefined;
  const own = openCli ? value[openCli.id] : undefined;
  const models = openCli?.models ?? [];
  const efforts = own ? effortsFor(models, own.model) : [];

  return (
    <>
      {clis.map((c) => {
        const pick = value[c.id];
        const summary = pick
          ? [
              pick.model ? (c.models?.find((m) => m.id === pick.model)?.name ?? pick.model) : t("modelPicker.cliDefault"),
              pick.effort && effortName(pick.effort, t),
            ]
              .filter(Boolean)
              .join(" · ")
          : t("evaluator.unused");
        return <ValueRow key={c.id} label={cliName(c.id)} value={summary} onPress={disabled ? undefined : () => setOpen(c.id)} />;
      })}
      {openCli && (
        <Sheet open onClose={() => setOpen(null)} title={cliName(openCli.id)}>
          <ScrollView style={{ maxHeight: 520 }}>
            <Option kind="check" wrap checked={!!own} title={t("evaluator.use")} onPress={() => set(openCli.id, own ? null : {})} />
            {own && !!openCli.accounts?.length && (
              <>
                <Text style={styles.part}>{t("projectSettings.cliAccount", { cli: cliName(openCli.id) })}</Text>
                {cliLogins(openCli).map((l) => (
                  <Option
                    key={l.account ?? ""}
                    kind="radio"
                    checked={(own.account ?? null) === l.account}
                    title={l.name ?? t("cliPicker.ownLogin")}
                    onPress={() => set(openCli.id, { account: l.account })}
                  />
                ))}
              </>
            )}
            {own && (
              <>
                <Text style={styles.part}>{t("evaluator.model")}</Text>
                {models.length === 0 ? (
                  <Text style={styles.empty}>{t("evaluator.noModels")}</Text>
                ) : (
                  <>
                    <Option kind="radio" checked={!own.model} title={t("modelPicker.cliDefault")} onPress={() => set(openCli.id, { model: null })} />
                    {models.map((m) => (
                      <Option key={m.id} kind="radio" checked={own.model === m.id} title={m.name} onPress={() => set(openCli.id, { model: m.id })} />
                    ))}
                  </>
                )}
                <Text style={styles.part}>{t("modelPicker.effort")}</Text>
                {efforts.length > 0 ? (
                  [null, ...efforts].map((e) => (
                    <Option
                      key={e ?? ""}
                      kind="radio"
                      checked={(own.effort ?? null) === e}
                      title={e ? effortName(e, t) : t("modelPicker.effortDefault")}
                      onPress={() => set(openCli.id, { effort: e })}
                    />
                  ))
                ) : (
                  <Text style={styles.empty}>{t("modelPicker.noEffort")}</Text>
                )}
              </>
            )}
          </ScrollView>
        </Sheet>
      )}
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
