import { describe, expect, it, vi } from "vitest";
import { externalUrl, openLinksExternally } from "../src/external-links";

const APP = "tauri://localhost";

describe("externalUrl", () => {
  it("sends other sites to the browser", () => {
    expect(externalUrl("https://github.com/Fibteq-Inc/myrel/pull/1", APP)).toBe(
      "https://github.com/Fibteq-Inc/myrel/pull/1",
    );
    expect(externalUrl("http://example.com", APP)).toBe("http://example.com/");
    expect(externalUrl("mailto:a@b.co", APP)).toBe("mailto:a@b.co");
  });

  it("keeps the app's own links and other schemes in the app", () => {
    expect(externalUrl("/projects/1", APP)).toBeNull();
    expect(externalUrl("http://localhost:5173/projects/1", "http://localhost:5173")).toBeNull();
    expect(externalUrl("blob:tauri://localhost/123", APP)).toBeNull();
    expect(externalUrl("javascript:alert(1)", APP)).toBeNull();
    expect(externalUrl("#top", APP)).toBeNull();
  });
});

function fakeWindow() {
  const listeners = new Map<string, (e: MouseEvent) => void>();
  const nativeOpen = vi.fn(() => null);
  const win = {
    location: { origin: APP },
    open: nativeOpen,
    document: {
      addEventListener: (type: string, fn: (e: MouseEvent) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
  };
  const click = (href: string, init: { button?: number; download?: boolean; prevented?: boolean } = {}) => {
    const anchor = {
      getAttribute: () => href,
      hasAttribute: (name: string) => name === "download" && !!init.download,
    };
    const event = {
      button: init.button ?? 0,
      defaultPrevented: !!init.prevented,
      target: { closest: () => anchor },
      preventDefault: vi.fn(),
    };
    listeners.get(event.button === 1 ? "auxclick" : "click")?.(event as unknown as MouseEvent);
    return event;
  };
  return { win: win as unknown as Window, nativeOpen, listeners, click };
}

describe("openLinksExternally", () => {
  it("opens external link clicks in the browser instead of the webview", () => {
    const { win, click } = fakeWindow();
    const open = vi.fn();
    openLinksExternally(win, open);

    const event = click("https://github.com/Fibteq-Inc/myrel/pull/1");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://github.com/Fibteq-Inc/myrel/pull/1");

    click("https://example.com", { button: 1 });
    expect(open).toHaveBeenLastCalledWith("https://example.com/");
  });

  it("leaves app links, downloads and handled clicks alone", () => {
    const { win, click } = fakeWindow();
    const open = vi.fn();
    openLinksExternally(win, open);

    expect(click("/projects/1").preventDefault).not.toHaveBeenCalled();
    click("https://example.com/file.pdf", { download: true });
    click("https://example.com", { prevented: true });
    click("https://example.com", { button: 2 });
    expect(open).not.toHaveBeenCalled();
  });

  it("routes window.open for other sites to the browser and undoes itself", () => {
    const { win, nativeOpen, listeners } = fakeWindow();
    const open = vi.fn();
    const undo = openLinksExternally(win, open);

    expect(win.open("https://example.com", "_blank")).toBeNull();
    expect(open).toHaveBeenCalledWith("https://example.com/");
    win.open("/projects/1");
    expect(nativeOpen).toHaveBeenCalledWith("/projects/1");

    undo();
    expect(win.open).toBe(nativeOpen);
    expect(listeners.size).toBe(0);
  });
});
