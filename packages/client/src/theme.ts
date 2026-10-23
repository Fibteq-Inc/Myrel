/** Light or dark, as the app draws itself. */
export type Theme = "light" | "dark";
/** What the person picked in Settings; "system" follows the device. */
export type ThemePreference = Theme | "system";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const satisfies readonly ThemePreference[];
export const THEME_STORAGE_KEY = "myrel.theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** A saved value, or "system" when nothing (or something unknown) was saved. */
export function parseThemePreference(saved: unknown): ThemePreference {
  return isThemePreference(saved) ? saved : "system";
}

/** The theme to draw: the person's pick, else the device's; dark when the device says nothing. */
export function resolveTheme(preference: ThemePreference, system: Theme | null | undefined): Theme {
  if (preference !== "system") return preference;
  return system === "light" ? "light" : "dark";
}
