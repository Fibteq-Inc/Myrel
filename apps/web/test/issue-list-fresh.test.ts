import { ISSUE_LIST_FRESHNESS } from "@myrel/client";
import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Issues tab's list, as the screens use it: an observer that subscribes when the list comes on
 * screen. The client has the apps' default staleTime, which the list must override.
 */
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
  let issues = ["#1"];
  const list = vi.fn(async () => [...issues]);
  const options = { queryKey: ["issues"], queryFn: list, ...ISSUE_LIST_FRESHNESS };
  const show = async (extra: { enabled?: boolean } = {}) => {
    const observer = new QueryObserver(client, { ...options, ...extra });
    const hide = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    return { observer, hide };
  };
  return { client, list, options, show, open: (n: string) => (issues = [n, ...issues]) };
}

describe("the issue list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Tests run without a window, which the library takes for a server: no refetch timers there.
    environmentManager.setIsServer(() => false);
  });
  afterEach(() => {
    vi.useRealTimers();
    environmentManager.setIsServer(() => typeof window === "undefined");
  });

  it("shows an issue opened since, when the list comes back on screen right away", async () => {
    const { client, list, show, open } = setup();
    const first = await show();
    expect(first.observer.getCurrentResult().data).toEqual(["#1"]);
    first.hide();

    open("#2");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await show();
    expect(list).toHaveBeenCalledTimes(2);
    expect(second.observer.getCurrentResult().data).toEqual(["#2", "#1"]);
    second.hide();
    client.clear();
  });

  it("keeps showing the old list while it asks again", async () => {
    const { client, show } = setup();
    (await show()).hide();
    const second = new QueryObserver(client, { queryKey: ["issues"], queryFn: () => new Promise<string[]>(() => {}), ...ISSUE_LIST_FRESHNESS });
    const hide = second.subscribe(() => {});
    expect(second.getCurrentResult().data).toEqual(["#1"]);
    expect(second.getCurrentResult().isPending).toBe(false);
    hide();
    client.clear();
  });

  it("finds a new issue by itself while it stays on screen", async () => {
    const { client, show, open } = setup();
    const { observer, hide } = await show();
    open("#2");
    await vi.advanceTimersByTimeAsync(ISSUE_LIST_FRESHNESS.refetchInterval);
    expect(observer.getCurrentResult().data).toEqual(["#2", "#1"]);
    hide();
    client.clear();
  });

  it("asks again when its screen is back in front (mobile, after an opened issue)", async () => {
    const { client, list, options, show, open } = setup();
    const { observer, hide } = await show();
    observer.setOptions({ ...options, enabled: false });
    open("#2");
    await vi.advanceTimersByTimeAsync(ISSUE_LIST_FRESHNESS.refetchInterval * 2);
    expect(list).toHaveBeenCalledTimes(1);

    observer.setOptions({ ...options, enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toEqual(["#2", "#1"]);
    hide();
    client.clear();
  });
});
