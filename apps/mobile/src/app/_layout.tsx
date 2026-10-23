import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, SplashScreen, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useEffect, useMemo } from "react";
import { AppI18n } from "../lib/i18n";
import { unregisterPush } from "../lib/push";
import { SessionProvider, useSession } from "../lib/session";
import { AppTheme } from "../lib/theme";
import { useColors, useTheme } from "../theme";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

export default function RootLayout() {
  return (
    <AppTheme>
      <NavigationTheme>
        <AppI18n>
        <QueryClientProvider client={queryClient}>
          <SessionProvider
            onSignOut={async (api) => {
              // The cached data is the account's: cleared even when unregistering push fails.
              try {
                await unregisterPush(api);
              } finally {
                queryClient.clear();
              }
            }}
          >
            <Routes />
          </SessionProvider>
        </QueryClientProvider>
        </AppI18n>
      </NavigationTheme>
    </AppTheme>
  );
}

/** The navigator's own colors (headers, cards, transitions) and the status bar, from the app theme. */
function NavigationTheme({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const colors = useColors();
  const value = useMemo(() => {
    const base = theme === "light" ? DefaultTheme : DarkTheme;
    return {
      ...base,
      colors: { ...base.colors, background: colors.ground, card: colors.ground, border: colors.line, primary: colors.accent, text: colors.fg },
    };
  }, [theme, colors]);
  return (
    <ThemeProvider value={value}>
      <StatusBar style={theme === "light" ? "dark" : "light"} />
      {children}
    </ThemeProvider>
  );
}

function Routes() {
  const colors = useColors();
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
