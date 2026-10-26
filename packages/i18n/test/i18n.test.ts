import { describe, expect, it, vi } from "vitest";
import { catalogs, clockTime, createTranslator, dayLabel, LOCALES, localDay, matchLocale, relativeTime } from "../src";

const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const other = (message: string | { other: string }) => (typeof message === "string" ? message : message.other);

describe("catalogs", () => {
  it("use the same parameters as English in every message", () => {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(catalogs[locale])) {
        const expected = params(other(catalogs.en[key as keyof typeof catalogs.en]));
        expect(params(other(message)), `${locale} ${key}`).toEqual(expected);
        // Other plural forms may drop {count} ("1 reply") but add nothing new.
        if (typeof message !== "string") {
          for (const text of Object.values(message)) {
            for (const p of params(text!)) expect(expected, `${locale} ${key}`).toContain(p);
          }
        }
      }
    }
  });
});

describe("matchLocale", () => {
  it("picks the first supported language", () => {
    expect(matchLocale(["de-DE", "tr-TR", "en"])).toBe("tr");
    expect(matchLocale(["en-GB"])).toBe("en");
  });
  it("falls back to English", () => {
    expect(matchLocale(["fr"])).toBe("en");
    expect(matchLocale(undefined)).toBe("en");
  });
});

describe("createTranslator", () => {
  it("interpolates and picks plural forms", () => {
    const en = createTranslator("en");
    expect(en("threadCard.replies", { count: 1 })).toBe("1 reply");
    expect(en("threadCard.replies", { count: 3 })).toBe("3 replies");
    expect(en("server.current", { host: "a.dev" })).toBe("Server: a.dev");
    expect(createTranslator("tr")("threadCard.replies", { count: 3 })).toBe("3 yanıt");
  });
  it("picks plural forms without Intl.PluralRules (Hermes)", () => {
    vi.stubGlobal("Intl", { ...Intl, PluralRules: undefined });
    try {
      const en = createTranslator("en");
      expect(en("threadCard.replies", { count: 1 })).toBe("1 reply");
      expect(en("threadCard.replies", { count: 3 })).toBe("3 replies");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("leaves unknown parameters in place", () => {
    expect(createTranslator("en")("server.current")).toBe("Server: {host}");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  it("reads in the chosen language", () => {
    expect(relativeTime(createTranslator("en"), "en", "2026-10-19T11:55:00Z", now)).toBe("5m");
    expect(relativeTime(createTranslator("tr"), "tr", "2026-10-19T09:00:00Z", now)).toBe("3 sa");
    expect(relativeTime(createTranslator("tr"), "tr", "2026-10-19T11:59:30Z", now)).toBe("şimdi");
  });
});

describe("dayLabel and clockTime", () => {
  const now = new Date(2026, 9, 26, 14, 0).getTime();
  it("names today and yesterday, then dates", () => {
    const en = createTranslator("en");
    expect(dayLabel(en, "en", new Date(2026, 9, 26, 0, 5).toISOString(), now)).toBe("Today");
    expect(dayLabel(createTranslator("tr"), "tr", new Date(2026, 9, 25, 23, 50).toISOString(), now)).toBe("Dün");
    expect(dayLabel(en, "en", new Date(2026, 9, 23, 12).toISOString(), now)).toBe("Fri, Oct 23");
    expect(dayLabel(en, "en", new Date(2025, 9, 23, 12).toISOString(), now)).toContain("2025");
  });
  it("shows a 24-hour local time", () => {
    expect(clockTime("tr", new Date(2026, 9, 26, 9, 5).toISOString())).toBe("09:05");
  });
  it("groups by local day", () => {
    expect(localDay(new Date(2026, 0, 2, 23, 59).getTime())).toBe("2026-01-02");
  });
});
