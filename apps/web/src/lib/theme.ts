import {
  parseThemePreference,
  resolveTheme,
  type Theme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@myrel/client";
import { useSyncExternalStore } from "react";
import { platform } from "./api";

// Synchronous storage on purpose: the theme must be known before the first paint.
function load(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

const lightQuery = window.matchMedia?.("(prefers-color-scheme: light)");
let preference = load();
const listeners = new Set<() => void>();

const systemTheme = (): Theme => (lightQuery?.matches ? "light" : "dark");

/** Draws the page in the resolved theme; the CSS palettes key off `data-theme` on <html>. */
function apply() {
  const theme = resolveTheme(preference, systemTheme());
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  // The desktop window's title bar follows the pick too; "system" hands it back to the OS.
  void platform.setWindowTheme?.(preference === "system" ? null : theme);
}

function emit() {
  apply();
  for (const listener of listeners) listener();
}

/** Applies the saved theme now and follows the device from here on. Call once before rendering. */
export function initTheme() {
  apply();
  lightQuery?.addEventListener("change", () => {
    if (preference === "system") emit();
  });
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private mode: the choice lasts until reload.
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The person's pick: system, light or dark. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/** The theme being drawn right now. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => resolveTheme(preference, systemTheme()));
}
