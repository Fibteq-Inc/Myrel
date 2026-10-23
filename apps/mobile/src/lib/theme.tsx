import { parseThemePreference, resolveTheme, THEME_STORAGE_KEY, type ThemePreference } from "@myrel/client";
import * as SystemUI from "expo-system-ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useColorScheme } from "react-native";
import { palettes, ThemeContext } from "../theme";
import { platform } from "./platform";

const PreferenceContext = createContext<{ preference: ThemePreference; setPreference: (next: ThemePreference) => void }>({
  preference: "system",
  setPreference: () => {},
});

/** The person's pick (system, light or dark) and a setter that keeps it on this device. */
export function useThemePreference() {
  return useContext(PreferenceContext);
}

/**
 * Draws the app light or dark: the saved pick, else the device's appearance, followed live.
 * Renders nothing until the pick is read, so the first screen never flips theme.
 */
export function AppTheme({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setState] = useState<ThemePreference | null>(null);
  useEffect(() => {
    void Promise.resolve(platform.storage.get(THEME_STORAGE_KEY))
      .catch(() => null)
      .then((saved) => setState(parseThemePreference(saved)));
  }, []);
  const setPreference = useCallback((next: ThemePreference) => {
    setState(next);
    void platform.storage.set(THEME_STORAGE_KEY, next);
  }, []);
  const theme = resolveTheme(preference ?? "system", system === "light" || system === "dark" ? system : null);
  // The root view behind every screen (shows during transitions and the keyboard).
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palettes[theme].ground);
  }, [theme]);
  if (!preference) return null;
  return (
    <PreferenceContext.Provider value={{ preference, setPreference }}>
      <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
    </PreferenceContext.Provider>
  );
}
