import { useI18n } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { Empty } from "../../../../components/project/empty";
import { errorMessage, Spinner } from "../../../../components/ui";
import { useProject } from "../../../../lib/project";
import { useSession } from "../../../../lib/session";
import { colors, mono } from "../../../../theme";

/** Largest text file shown in full; longer ones are cut. */
const MAX_TEXT = 200_000;

type Preview = { kind: "text"; text: string } | { kind: "image"; uri: string } | { kind: "none" };

function isText(type: string, path: string) {
  return (
    type.startsWith("text/") ||
    /json|xml|javascript|typescript|yaml|toml|csv|markdown/.test(type) ||
    /\.(md|txt|json|ya?ml|toml|csv|tsx?|jsx?|py|go|rs|sh|html?|css|sql)$/i.test(path)
  );
}

function readBlob(blob: Blob, as: "text" | "dataURL") {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    if (as === "text") reader.readAsText(blob);
    else reader.readAsDataURL(blob);
  });
}

/**
 * A preview of one project file, or with `local`, one in the project's folder on this person's
 * computer (an agent's message pointed to it; `thread` is where its worktree is): text and images;
 * other kinds just show their name.
 */
export default function FileScreen() {
  const { t } = useI18n();
  const { path, local, thread } = useLocalSearchParams<{ path: string; local?: string; thread?: string }>();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const preview = useQuery({
    queryKey: local ? ["local-file", server, projectId, thread ?? null, path] : ["file", server, projectId, path],
    queryFn: async (): Promise<Preview> => {
      const blob = local ? await api.getLocalFile(projectId, path, thread) : await api.getFile(projectId, path);
      if (blob.type.startsWith("image/")) return { kind: "image", uri: await readBlob(blob, "dataURL") };
      if (isText(blob.type, path)) return { kind: "text", text: (await readBlob(blob, "text")).slice(0, MAX_TEXT) };
      return { kind: "none" };
    },
    retry: local ? false : undefined,
  });
  const name = path.split("/").pop() ?? path;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: name }} />
      {preview.isPending ? (
        <View style={styles.center}>
          <Spinner size={22} color={colors.subtle} />
        </View>
      ) : preview.error ? (
        <Empty title={t("files.loadFailed")} body={errorMessage(preview.error, t("common.error"))} />
      ) : preview.data.kind === "text" ? (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text selectable style={styles.code}>
            {preview.data.text}
          </Text>
        </ScrollView>
      ) : preview.data.kind === "image" ? (
        <Image source={{ uri: preview.data.uri }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel={name} />
      ) : (
        <Empty title={name} body={t("mobile.noPreview")} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  code: { color: colors.body, fontFamily: mono, fontSize: 13, lineHeight: 19 },
});
