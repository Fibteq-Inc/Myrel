import { codeLanguage } from "@myrel/client";
import { useI18n } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { Share2 } from "lucide-react-native";
import { useState } from "react";
import {
  Alert,
  Image,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CodeView } from "../../../../components/code-view";
import { MessageMarkdown } from "../../../../components/markdown";
import { Empty } from "../../../../components/project/empty";
import { Button, errorMessage, Spinner } from "../../../../components/ui";
import { displayName, type FileKind, fileKind } from "../../../../lib/files";
import { useOpenLink } from "../../../../lib/links";
import { openWithSystem } from "../../../../lib/open-file";
import { useProject } from "../../../../lib/project";
import { useSession } from "../../../../lib/session";
import { makeStyles, mono, useColors } from "../../../../theme";

/** Largest text file shown in full; longer ones are cut. */
const MAX_TEXT = 200_000;

/** The file as a data URL (what the phone's viewer gets), and its text when it is text. */
type Preview = { kind: FileKind; type: string; dataUrl: string; text?: string };

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
 * computer (an agent's message pointed to it; `thread` is where its worktree is): text (code
 * with syntax colors and line numbers), Markdown drawn like agent messages (links and file paths
 * open as they do there), and images that pinch to zoom on iOS. The header button hands any file
 * to the phone (Quick Look on iOS, a viewer app on Android) to zoom, share or save it; files with
 * no preview offer that in place.
 */
export default function FileScreen() {
  const { t } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const { path, local, thread } = useLocalSearchParams<{ path: string; local?: string; thread?: string }>();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const preview = useQuery({
    queryKey: local ? ["local-file", server, projectId, thread ?? null, path] : ["file", server, projectId, path],
    queryFn: async (): Promise<Preview> => {
      const blob = local ? await api.getLocalFile(projectId, path, thread) : await api.getFile(projectId, path);
      const kind = fileKind(blob.type, path);
      const dataUrl = await readBlob(blob, "dataURL");
      const text = kind === "text" || kind === "markdown" ? (await readBlob(blob, "text")).slice(0, MAX_TEXT) : undefined;
      return { kind, type: blob.type, dataUrl, text };
    },
    retry: local ? false : undefined,
  });
  const openLink = useOpenLink(projectId, thread);
  const name = displayName(path);
  const language = codeLanguage(path);
  const [opening, setOpening] = useState(false);

  const open = async () => {
    if (!preview.data || opening) return;
    setOpening(true);
    try {
      await openWithSystem(preview.data.dataUrl, path, preview.data.type);
    } catch (err) {
      Alert.alert(t("mobile.openFileFailed"), errorMessage(err, ""));
    } finally {
      setOpening(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () =>
            preview.data ? (
              <Pressable accessibilityLabel={t("mobile.openFile")} hitSlop={10} disabled={opening} onPress={() => void open()}>
                <Share2 size={20} color={opening ? colors.subtle : colors.fg} />
              </Pressable>
            ) : null,
        }}
      />
      {preview.isPending ? (
        <View style={styles.center}>
          <Spinner size={22} color={colors.subtle} />
        </View>
      ) : preview.error ? (
        <Empty title={t("files.loadFailed")} body={errorMessage(preview.error, t("common.error"))} />
      ) : preview.data.kind === "markdown" ? (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <MessageMarkdown body={preview.data.text ?? ""} onLink={openLink} />
        </ScrollView>
      ) : preview.data.kind === "text" && language ? (
        <CodeView text={preview.data.text ?? ""} language={language} />
      ) : preview.data.kind === "text" ? (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text selectable style={styles.code}>
            {preview.data.text}
          </Text>
        </ScrollView>
      ) : preview.data.kind === "image" ? (
        <ZoomableImage uri={preview.data.dataUrl} label={name} onOpen={() => void open()} />
      ) : (
        <View style={{ flex: 1 }}>
          <Empty title={name} body={t("mobile.noPreviewOpen")} />
          <View style={{ paddingHorizontal: 24 }}>
            <Button onPress={() => void open()} pending={opening}>
              {t("mobile.openFile")}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * The image fit to the screen. iOS zooms it with a pinch in place; Android's ScrollView cannot
 * zoom, so a tap there opens it in the phone's viewer instead.
 */
function ZoomableImage({ uri, label, onOpen }: { uri: string; label: string; onOpen: () => void }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const image = size.height > 0 && (
    <Image source={{ uri }} style={size} resizeMode="contain" accessibilityLabel={label} />
  );
  const measure = (e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  if (Platform.OS !== "ios")
    return (
      <Pressable style={{ flex: 1 }} onLayout={measure} onPress={onOpen}>
        {image}
      </Pressable>
    );
  return (
    <ScrollView
      style={{ flex: 1 }}
      onLayout={measure}
      maximumZoomScale={5}
      minimumZoomScale={1}
      centerContent
      bouncesZoom
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {image}
    </ScrollView>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    code: { color: colors.body, fontFamily: mono, fontSize: 13, lineHeight: 19 },
  }),
);
