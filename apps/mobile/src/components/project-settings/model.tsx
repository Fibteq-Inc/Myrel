import { useT } from "@myrel/i18n/react";
import type { ProviderId } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSession } from "../../lib/session";
import { Option, Sheet } from "../cli-picker";
import { Notice, Section, ValueRow } from "../settings-section";
import { Button, errorMessage, Input } from "../ui";
import { useProjectSettings } from "./general";

/**
 * The coordinator's provider, model and key, as in the web's "Model and key" tab. Keys are added
 * under the web's Settings → Model keys; here a project picks among the ones the person can see.
 */
export function ModelSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const { api, server } = useSession();
  const { settings, save } = useProjectSettings(projectId);
  const providers = useQuery({ queryKey: ["providers", server], queryFn: () => api.listProviders() });
  const keys = useQuery({ queryKey: ["keys", server], queryFn: () => api.listKeys() });
  const [open, setOpen] = useState<"provider" | "key" | null>(null);
  const [model, setModel] = useState("");
  const savedModel = settings.data?.model ?? "";
  useEffect(() => setModel(savedModel), [savedModel]);
  if (!settings.data) return null;
  const s = settings.data;

  const list = providers.data;
  const effective = s.provider ?? list?.serverDefault;
  const info = list?.providers.find((p) => p.id === effective);
  const usableKeys = (keys.data ?? []).filter((k) => k.provider === effective);
  // A key you cannot see (someone else's) stays selected but is shown as such.
  const foreignKey = !!s.keyId && !(keys.data ?? []).some((k) => k.id === s.keyId);
  const ownKey = (keys.data ?? []).find((k) => k.id === s.keyId);
  const serverDefault = list
    ? t("projectSettings.serverDefaultNamed", { name: list.providers.find((p) => p.id === list.serverDefault)?.name ?? "" })
    : t("projectSettings.serverDefault");
  const keyLabel = ownKey
    ? `${ownKey.label} ${ownKey.hint}`
    : foreignKey
      ? t("projectSettings.foreignKey")
      : info?.serverKey
        ? t("projectSettings.serverKey")
        : t("projectSettings.noKey");
  const modelChanged = model.trim() !== (s.model ?? "");

  return (
    <>
      <Section title={t("projectSettings.model")} hint={t("projectSettings.modelDescription")}>
        <ValueRow
          label={t("projectSettings.provider")}
          value={s.provider ? (list?.providers.find((p) => p.id === s.provider)?.name ?? s.provider) : serverDefault}
          onPress={canManage ? () => setOpen("provider") : undefined}
        />
        <View style={{ gap: 10, paddingTop: 6 }}>
          <Input
            value={model}
            onChangeText={setModel}
            editable={canManage}
            accessibilityLabel={t("projectSettings.model")}
            placeholder={info?.defaultModel ?? t("projectSettings.modelPlaceholder")}
            returnKeyType="done"
            onSubmitEditing={() => modelChanged && save.mutate({ model: model.trim() || null })}
          />
          {info && <Notice>{t("projectSettings.modelHint", { model: info.defaultModel })}</Notice>}
          {canManage && modelChanged && (
            <Button onPress={() => save.mutate({ model: model.trim() || null })} pending={save.isPending && save.variables?.model !== undefined}>
              {t("settings.saveChanges")}
            </Button>
          )}
        </View>
      </Section>

      <Section title={t("projectSettings.key")} hint={`${t("projectSettings.keyHintBefore")} ${t("settings.keys")}${t("projectSettings.keyHintAfter")}`}>
        <ValueRow label={t("projectSettings.key")} value={keyLabel} onPress={canManage ? () => setOpen("key") : undefined} />
        {!s.keyId && info && !info.serverKey && <Notice>{t("projectSettings.missingKey", { provider: info.name })}</Notice>}
        {save.error && <Notice tone="bad">{errorMessage(save.error, t("common.error"))}</Notice>}
      </Section>

      <Sheet open={open === "provider"} onClose={() => setOpen(null)} title={t("projectSettings.provider")}>
        <ScrollView style={{ maxHeight: 360 }}>
          {[null, ...(list?.providers ?? []).map((p) => p.id)].map((id: ProviderId | null) => (
            <Option
              key={id ?? ""}
              kind="radio"
              checked={s.provider === id}
              title={id ? (list?.providers.find((p) => p.id === id)?.name ?? id) : serverDefault}
              onPress={() => {
                // Another provider takes its own model and key, as on the web.
                if (id !== s.provider) save.mutate({ provider: id, model: null, keyId: null });
                setOpen(null);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>
      <Sheet open={open === "key"} onClose={() => setOpen(null)} title={t("projectSettings.key")}>
        <ScrollView style={{ maxHeight: 360 }}>
          <Option
            kind="radio"
            checked={!s.keyId}
            title={info?.serverKey ? t("projectSettings.serverKey") : t("projectSettings.noKey")}
            onPress={() => {
              if (s.keyId) save.mutate({ keyId: null });
              setOpen(null);
            }}
          />
          {foreignKey && <Option kind="radio" checked title={t("projectSettings.foreignKey")} onPress={() => setOpen(null)} />}
          {usableKeys.map((k) => (
            <Option
              key={k.id}
              kind="radio"
              checked={s.keyId === k.id}
              title={`${k.label} ${k.hint}`}
              note={k.scope === "instance" ? t("projectSettings.shared") : undefined}
              onPress={() => {
                if (k.id !== s.keyId) save.mutate({ keyId: k.id });
                setOpen(null);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}
