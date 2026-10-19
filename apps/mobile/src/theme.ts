/** Design tokens, matching apps/web (dark-first, see the design canvas). */
export const colors = {
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
} as const;

export const mono = "Menlo";

export const radius = { sm: 8, md: 12, lg: 16 } as const;
