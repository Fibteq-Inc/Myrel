import { Stack, useLocalSearchParams } from "expo-router";
import { ExternalLink } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Spinner } from "../../components/ui";
import { platform } from "../../lib/platform";
import { colors } from "../../theme";

/**
 * Artifacts (and other pages linked from messages) open here, in a WebView.
 * Artifacts are served from their own domain, so the page never shares the
 * app's session; the button hands the page to the system browser.
 */
export default function ArtifactScreen() {
  const { url } = useLocalSearchParams<{ url: string }>();
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const valid = typeof url === "string" && /^https?:\/\//i.test(url);

  return (
    <View style={{ flex: 1, backgroundColor: colors.ground }}>
      <Stack.Screen
        options={{
          title: title || (valid ? new URL(url).host : ""),
          headerRight: () =>
            valid ? (
              <Pressable accessibilityLabel="Open in browser" hitSlop={10} onPress={() => void platform.openExternal(url)}>
                <ExternalLink size={20} color={colors.fg} />
              </Pressable>
            ) : null,
        }}
      />
      {valid ? (
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
      ) : (
        <Text style={styles.error}>This link can't be opened.</Text>
      )}
      {valid && loading && (
        <View style={styles.loading} pointerEvents="none">
          <Spinner size={22} color={colors.subtle} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.bad, padding: 24, fontSize: 15 },
  loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
});
