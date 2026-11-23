import { useT } from "@myrel/i18n/react";
import type { CliId, CliModel } from "@myrel/protocol";
import { ScrollView, StyleSheet, Text } from "react-native";
import { makeStyles } from "../theme";
import { cliName, Option, Sheet } from "./cli-picker";
import { ValueRow } from "./settings-section";

/** The model that judges a CLI's commands at auto access (REVIEW_CLIS): the picked one, tapped to change. */
export function ReviewModelRow({ cli, hint, value, onPress }: { cli: CliId; hint: string; value: string; onPress?: () => void }) {
  const t = useT();
  const styles = useStyles();
  return (
    <>
      <ValueRow label={t("reviewModel.title", { cli: cliName(cli) })} value={value} onPress={onPress} />
      <Text style={styles.hint}>{hint}</Text>
    </>
  );
}

/** Picks it from the CLI's own list; `none` names what judges when nothing is picked. */
export function ReviewModelSheet({
  cli,
  models,
  value,
  none,
  onPick,
  onClose,
}: {
  cli: CliId;
  models: CliModel[];
  value: string | null;
  none: string;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Sheet open onClose={onClose} title={t("reviewModel.title", { cli: cliName(cli) })}>
      <ScrollView style={{ maxHeight: 360 }}>
        <Option kind="radio" checked={!value} title={none} onPress={() => onPick(null)} />
        {/* A pick the CLI no longer lists stays visible until someone changes it. */}
        {value && !models.some((m) => m.id === value) && <Option kind="radio" checked title={value} onPress={onClose} />}
        {models.map((m) => (
          <Option key={m.id} kind="radio" checked={value === m.id} title={m.name} onPress={() => onPick(m.id)} />
        ))}
      </ScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
  }),
);
