import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { ExternalLink } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { errorMessage, Spinner } from "../../components/ui";
import { platform } from "../../lib/platform";
import { useSession } from "../../lib/session";
import { colors } from "../../theme";

type Params = { url?: string; projectId?: string; artifactId?: string; version?: string };

/**
 * Artifacts, and other pages linked from messages, open here in a WebView.
 * An artifact is framed through a signed, short-lived link on its own origin,
 * so the page never shares the app's session; the button hands the page to
 * the system browser.
 */
export default function ArtifactScreen() {
  const t = useT();
  const { api, server } = useSession();
  const params = useLocalSearchParams<Params>();
  const isArtifact = !!params.projectId && !!params.artifactId;
  const version = params.version ? Number(params.version) : undefined;
  const view = useQuery({
    queryKey: ["artifact-view", server, params.projectId, params.artifactId, version],
    queryFn: () => api.artifactView(params.projectId!, params.artifactId!, version),
    enabled: isArtifact,
    staleTime: 0,
  });
  const url = isArtifact ? view.data?.url : params.url;
  const valid = typeof url === "string" && /^https?:\/\//i.test(url);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);

  let body;
  if (isArtifact && view.isPending) body = <Centered><Spinner size={22} color={colors.subtle} /></Centered>;
  else if (isArtifact && view.error) body = <Message title={errorMessage(view.error, t("common.error"))} />;
  else if (isArtifact && view.data?.url === null)
    body = <Message title={t("artifacts.noPreviews")} body={t("artifacts.noPreviewsBody")} />;
  else if (!valid) body = <Message title={t("mobile.badLink")} />;
  else
    body = (
      <>
        <WebView
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: colors.ground }}
          onLoadEnd={() => setLoading(false)}
          onNavigationStateChange={(nav) => setTitle(nav.title ?? "")}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowsBackForwardNavigationGestures
          setSupportMultipleWindows={false}
        />
        {loading && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Centered>
              <Spinner size={22} color={colors.subtle} />
            </Centered>
          </View>
        )}
      </>
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.ground }}>
      <Stack.Screen
        options={{
          title: title || (valid ? hostOf(url) : isArtifact ? t("artifacts.artifact") : ""),
          headerRight: () =>
            valid ? (
              <Pressable
                accessibilityLabel={t("mobile.openInBrowser")}
                hitSlop={10}
                onPress={() => void platform.openExternal(url)}
              >
                <ExternalLink size={20} color={colors.fg} />
              </Pressable>
            ) : null,
        }}
      />
      {body}
    </View>
  );
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>{children}</View>;
}

function Message({ title, body }: { title: string; body?: string }) {
  return (
    <View style={{ padding: 24, gap: 6 }}>
      <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }}>{title}</Text>
      {body && <Text style={{ color: colors.subtle, fontSize: 14, lineHeight: 20 }}>{body}</Text>}
    </View>
  );
}
