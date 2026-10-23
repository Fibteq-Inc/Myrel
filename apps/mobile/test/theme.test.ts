import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Colors, darkColors, lightColors, palettes } from "../src/theme";

/** WCAG 2 contrast ratio between two #rrggbb colors. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT = ["fg", "body", "muted", "subtle", "link", "accent", "ok", "warn", "bad"] as const;
const SURFACES = ["ground", "panel", "raised", "bubble", "sunken"] as const;

describe.each(Object.entries(palettes))("%s palette", (_name, colors: Colors) => {
  it("keeps every kind of text readable (WCAG AA, 4.5:1) on every surface", () => {
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        expect(contrast(colors[text], colors[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("keeps text on an accent fill readable", () => {
    expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps status text readable on its soft surface", () => {
    expect(contrast(colors.warn, colors.warnSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.accent, colors.accentSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.link, colors.accentSoft)).toBeGreaterThanOrEqual(4.5);
  });
});

/** `--color-name: #hex;` pairs inside the CSS block that starts at `start`. */
function cssTokens(css: string, start: string) {
  const from = css.indexOf(start);
  const block = css.slice(from, css.indexOf("\n}", from));
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/g)) {
    out[name!.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = value!;
  }
  return out;
}

describe("web palette", () => {
  const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
  const web = { dark: cssTokens(css, "@theme {"), light: cssTokens(css, ':root[data-theme="light"] {') };

  it("defines a light value for every dark token", () => {
    expect(Object.keys(web.dark).length).toBeGreaterThan(30);
    expect(Object.keys(web.light).sort()).toEqual(Object.keys(web.dark).sort());
  });

  it("matches the mobile palette wherever the names are shared", () => {
    for (const [theme, mobile] of [["dark", darkColors], ["light", lightColors]] as const) {
      for (const [name, value] of Object.entries(web[theme])) {
        if (name in mobile) expect(mobile[name as keyof Colors], `${theme} ${name}`).toBe(value);
      }
    }
  });

  it("keeps text readable on every surface in both themes", () => {
    for (const colors of [web.dark, web.light]) {
      for (const text of [...TEXT, "tabFg"]) {
        for (const surface of ["ground", "panel", "raised", "bubble", "sunken", "field", "menu", "console"]) {
          if (text === "tabFg") continue;
          expect(contrast(colors[text]!, colors[surface]!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(colors.tabFg!, colors.tab!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.bad!, colors.badSoft!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.ok!, colors.okSoft!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.warn!, colors.warnSoft!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.merged!, colors.raised!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
