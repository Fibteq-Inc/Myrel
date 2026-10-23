import { describe, expect, it } from "vitest";
import { isThemePreference, parseThemePreference, resolveTheme } from "../src/theme";

describe("theme preference", () => {
  it("accepts only system, light and dark", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
  it("falls back to system for nothing or junk", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("blue")).toBe("system");
    expect(parseThemePreference("dark")).toBe("dark");
  });
});

describe("resolveTheme", () => {
  it("follows the device on system", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
  });
  it("stays dark when the device says nothing", () => {
    expect(resolveTheme("system", null)).toBe("dark");
    expect(resolveTheme("system", undefined)).toBe("dark");
  });
  it("lets a manual pick win over the device", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });
});
