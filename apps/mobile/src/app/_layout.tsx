import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, SplashScreen, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { unregisterPush } from "../lib/push";
import { SessionProvider, useSession } from "../lib/session";
import { colors } from "../theme";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.ground, card: colors.ground, border: colors.line, primary: colors.accent, text: colors.fg },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider
          onSignOut={async (api) => {
            await unregisterPush(api);
            queryClient.clear();
          }}
        >
          <StatusBar style="light" />
          <Routes />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function Routes() {
  const { ready, user } = useSession();
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}
