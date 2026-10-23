import { useT } from "@myrel/i18n/react";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { registerForPush, useNotificationRouting } from "../../lib/push";
import { useApi } from "../../lib/session";
import { useColors } from "../../theme";

export default function AppLayout() {
  const t = useT();
  const colors = useColors();
  const api = useApi();
  useNotificationRouting();
  useEffect(() => {
    // Best effort: a server without push support simply never sends any.
    registerForPush(api).catch(() => {});
  }, [api]);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.ground },
        headerTintColor: colors.fg,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    >
      <Stack.Screen name="index" options={{ title: t("projects.title"), headerLargeTitle: true }} />
      <Stack.Screen name="projects/[projectId]" options={{ headerShown: false }} />
      <Stack.Screen name="artifact" options={{ presentation: "modal", title: "" }} />
      <Stack.Screen name="settings" options={{ presentation: "modal", title: t("settings.title") }} />
    </Stack>
  );
}
