import type { Theme } from "@myrel/client";
import { createContext, useContext } from "react";

/** Design tokens, matching apps/web/src/styles.css (the same names, both palettes). */
export const darkColors = {
  ground: "#0e0e10",
  panel: "#121215",
  raised: "#151518",
  bubble: "#1e1e23",
  hover: "#1c1c21",
  line: "#1f1f24",
  edge: "#2a2a30",
  fg: "#ececee",
  body: "#d4d4d8",
  muted: "#a1a1aa",
  subtle: "#8b8b94",
  accent: "#8b9bff",
  accentSoft: "#1e2142",
  link: "#b4beff",
  ok: "#4fcb8d",
  warn: "#f5b94a",
  warnSoft: "#17150f",
  warnLine: "#3b3218",
  bad: "#ff7b72",
  /** Added and removed lines in a diff. */
  okSoft: "#0f1713",
  badSoft: "#1f1212",
  // Surfaces and lines between the base steps above.
  sunken: "#0b0b0d",
  console: "#08080a",
  merged: "#b49cff",
  option: "#1a1a1e",
  card: "#26262b",
  divider: "#222227",
  frame: "#2e2e34",
  warnStrong: "#221e12",
  accentLine: "#2b3060",
  /** The send button: a deep accent with light text on it. */
  send: "#3a4180",
  /** Text and spinners on an accent fill. */
  onAccent: "#0e0e10",
  accentBorder: "rgba(139,155,255,0.6)",
  accentBorderSoft: "rgba(139,155,255,0.4)",
  accentWash: "rgba(30,33,66,0.35)",
  /** Dims the screen behind a bottom sheet. */
  scrim: "rgba(0,0,0,0.5)",
};

export type Colors = { [K in keyof typeof darkColors]: string };

export const lightColors: Colors = {
  ground: "#fbfbfc",
  panel: "#f5f5f7",
  raised: "#ffffff",
  bubble: "#eeeef2",
  hover: "#ececf0",
  line: "#e4e4e9",
  edge: "#d4d4db",
  fg: "#111114",
  body: "#2b2b31",
  muted: "#55555e",
  subtle: "#686872",
  accent: "#4a55d6",
  accentSoft: "#eceeff",
  link: "#3a45c4",
  ok: "#15713f",
  warn: "#935600",
  warnSoft: "#fff8e8",
  warnLine: "#eed49b",
  bad: "#bf2e29",
  okSoft: "#edf8f2",
  badSoft: "#fff1f0",
  sunken: "#f6f6f8",
  console: "#f3f3f6",
  merged: "#7a3fd1",
  option: "#ffffff",
  card: "#e2e2e8",
  divider: "#e9e9ee",
  frame: "#d7d7de",
  warnStrong: "#fdefc8",
  accentLine: "#c8cdf8",
  send: "#4a55d6",
  onAccent: "#ffffff",
  accentBorder: "rgba(74,85,214,0.55)",
  accentBorderSoft: "rgba(74,85,214,0.35)",
  accentWash: "rgba(236,238,255,0.6)",
  scrim: "rgba(17,17,20,0.3)",
};

export const palettes: Record<Theme, Colors> = { dark: darkColors, light: lightColors };

export const ThemeContext = createContext<Theme>("dark");

/** The theme being drawn: the person's pick in Settings, else the device's. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function useColors(): Colors {
  return palettes[useContext(ThemeContext)];
}

/**
 * Styles built from the palette, made once per theme:
 * `const useStyles = makeStyles((colors) => ({ ... }))`, then `const styles = useStyles()` in the component.
 */
export function makeStyles<T>(build: (colors: Colors) => T): () => T {
  const made: Partial<Record<Theme, T>> = {};
  return function useStyles() {
    const theme = useContext(ThemeContext);
    return (made[theme] ??= build(palettes[theme]));
  };
}

export const mono = "Menlo";

export const radius = { sm: 8, md: 12, lg: 16 } as const;
