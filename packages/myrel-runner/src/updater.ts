import type { RunnerUpdateState } from "@myrel/protocol";
import {
  clearMarker,
  downloadRunner,
  FAILED_SHOWN_MS,
  installBin,
  readMarker,
  restorePrevious,
  type UpdateMarker,
  writeMarker,
} from "./self-update";
import { isNewer, latestVersion } from "./update";

/** How long an update waits for running tasks before restarting anyway, as `myrel-runner update` does. */
export const UPDATE_WAIT_MS = 10 * 60 * 1000;
/**
 * How long auto-update waits for running tasks: nobody asked for it, so it waits for a quiet moment
 * instead of cutting a turn short, and only restarts anyway on a computer that is never idle.
 */
export const AUTO_UPDATE_WAIT_MS = 6 * 60 * 60 * 1000;
/** How long a new version has to connect before the previous one is put back. */
export const CONFIRM_MS = 2 * 60 * 1000;

export type UpdaterOptions = {
  /** This runner's version. */
  version: string;
  /** The tasks running now. */
  running: () => string[];
  /** Tells the server how the update goes (null: nothing to show). */
  report: (update: RunnerUpdateState | null) => void;
  log: (line: string) => void;
  /** Stops this runner and exits so that the background service starts the copy in its place. */
  restart: () => void;
  // For tests.
  download?: (version: string) => Promise<Buffer>;
  install?: (cli: Buffer, version: string) => Promise<void>;
  restore?: () => Promise<boolean>;
  latest?: () => Promise<string | null>;
  pollMs?: number;
  waitMs?: number;
  autoWaitMs?: number;
  now?: () => number;
};

/**
 * Updates the background runner in place, when Myrel asks or (with auto-update) by itself: waits for
 * its tasks, downloads and checks the new version, swaps the service's copy and restarts. The new
 * process confirms once the server welcomed it; if it is refused or never gets there, it puts the
 * previous copy back and restarts again.
 */
export class Updater {
  private current: RunnerUpdateState | null = null;
  /** Set while this process is a new version that has not connected yet. */
  private pending: UpdateMarker | null = null;
  private busy = false;
  private hurry = false;
  /** Until when a waiting update waits for running tasks. */
  private until = 0;

  constructor(private readonly opts: UpdaterOptions) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }

  /** What hello reports: an update in progress or one that did not work out lately. */
  state(): RunnerUpdateState | undefined {
    return this.current ?? undefined;
  }

  /** Looks at what the previous process left. True when this process is an update still to confirm. */
  async init(): Promise<boolean> {
    const marker = await readMarker();
    if (!marker) return false;
    if (marker.state === "restarting" && marker.version === this.opts.version) {
      this.pending = marker;
      return true;
    }
    if (marker.state === "restarting") {
      // The swap did not happen: still the old copy.
      await this.fail(marker.version, "The new version did not start, so this one kept running.", "failed", false);
      return false;
    }
    if ((marker.state === "failed" || marker.state === "rolled-back") && this.now - Date.parse(marker.at) < FAILED_SHOWN_MS) {
      const { from: _f, ...state } = marker;
      this.current = state;
      return false;
    }
    await clearMarker();
    return false;
  }

  /** The server welcomed this process: a pending update worked. */
  async confirmed(): Promise<void> {
    if (!this.pending) return;
    this.opts.log(`● Updated myrel-runner from ${this.pending.from} to ${this.opts.version}.`);
    this.pending = null;
    this.current = null;
    await clearMarker();
    this.opts.report(null);
  }

  /** This new version cannot work (refused, or never connected): back to the previous one. */
  async rollback(reason: string): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (!(await (this.opts.restore ?? restorePrevious)().catch(() => false))) {
      this.opts.log(`myrel-runner ${this.opts.version} could not connect (${reason}), and there is no previous version to go back to.`);
      return;
    }
    this.opts.log(`myrel-runner ${this.opts.version} could not connect (${reason}); going back to ${pending.from}.`);
    await writeMarker({
      state: "rolled-back",
      version: this.opts.version,
      from: pending.from,
      message: reason.slice(0, 500),
      at: new Date(this.now).toISOString(),
    });
    this.opts.restart();
  }

  /** Whether this process still waits to confirm an update. */
  get confirming(): boolean {
    return this.pending !== null;
  }

  /**
   * Starts updating to `version`. With `now`, running tasks are stopped (Myrel continues them);
   * otherwise it waits for them, at most UPDATE_WAIT_MS (AUTO_UPDATE_WAIT_MS for auto-update). Asking
   * again with `now` hurries a waiting one; asking without it cuts an auto-update's wait to UPDATE_WAIT_MS.
   */
  request(version: string, now = false, auto = false): RunnerUpdateState {
    if (!isNewer(version, this.opts.version)) throw new Error(`myrel-runner ${this.opts.version} is already up to date.`);
    const until = this.now + (auto ? (this.opts.autoWaitMs ?? AUTO_UPDATE_WAIT_MS) : (this.opts.waitMs ?? UPDATE_WAIT_MS));
    if (this.busy) {
      if (now) this.hurry = true;
      this.until = Math.min(this.until, until);
      return this.current!;
    }
    this.busy = true;
    this.hurry = now;
    this.until = until;
    this.set({ state: "waiting", version, running: this.opts.running().length });
    void this.run(version).finally(() => {
      this.busy = false;
    });
    return this.current!;
  }

  /** Auto-update: installs the newest version when there is one it has not failed on lately. */
  async checkNewest(): Promise<void> {
    if (this.busy || this.pending) return;
    const latest = await (this.opts.latest ?? latestVersion)();
    if (!latest || !isNewer(latest, this.opts.version)) return;
    if (this.current && this.current.version === latest && this.current.state !== "waiting") return;
    this.opts.log(`Installing myrel-runner ${latest} (auto-update is on).`);
    this.request(latest, false, true);
  }

  private async run(version: string) {
    for (let running = this.opts.running(); running.length && !this.hurry && this.now < this.until; running = this.opts.running()) {
      if (running.length !== this.current?.running) this.set({ state: "waiting", version, running: running.length });
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 2000));
    }
    try {
      this.set({ state: "downloading", version });
      const cli = await (this.opts.download ?? downloadRunner)(version);
      await (this.opts.install ?? installBin)(cli, version);
    } catch (err) {
      await this.fail(version, (err as Error).message);
      return;
    }
    const restarting: UpdateMarker = { state: "restarting", version, from: this.opts.version, at: new Date(this.now).toISOString() };
    await writeMarker(restarting);
    this.set({ state: "restarting", version });
    this.opts.log(`Restarting on myrel-runner ${version}…`);
    this.opts.restart();
  }

  private async fail(version: string, message: string, state: "failed" | "rolled-back" = "failed", log = true) {
    if (log) this.opts.log(`Could not update to myrel-runner ${version}: ${message}`);
    const at = new Date(this.now).toISOString();
    await writeMarker({ state, version, from: this.opts.version, message: message.slice(0, 500), at }).catch(() => {});
    this.set({ state, version, message: message.slice(0, 500) });
  }

  private set(state: Omit<RunnerUpdateState, "at">) {
    this.current = { ...state, at: new Date(this.now).toISOString() };
    this.opts.report(this.current);
  }
}
