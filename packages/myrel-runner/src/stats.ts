import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, platform, totalmem } from "node:os";
import { promisify } from "node:util";
import type { RunnerStats } from "@myrel/protocol";
import { childEnv, runnerHome } from "./config";

const run = promisify(execFile);

/** CPU time the cores have spent so far, summed: what a percentage is taken between two of these. */
export type CpuTimes = { idle: number; total: number };

export function cpuTimes(cores = cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of cores) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** How busy the cores were between two readings, 0–100; undefined when no time passed. */
export function cpuPercent(before: CpuTimes, after: CpuTimes): number | undefined {
  const total = after.total - before.total;
  if (total <= 0) return undefined;
  const busy = total - (after.idle - before.idle);
  return Math.round(Math.min(100, Math.max(0, (busy / total) * 100)) * 10) / 10;
}

export type Memory = { total: number; available: number; swap?: { total: number; used: number } };

/** Linux: /proc/meminfo, whose MemAvailable is what the kernel says programs can still take. */
export function parseMeminfo(text: string): Memory | undefined {
  const kb = (name: string) => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable") ?? kb("MemFree");
  if (total === undefined || available === undefined) return undefined;
  const swapTotal = kb("SwapTotal");
  const swapFree = kb("SwapFree");
  return {
    total,
    available: Math.min(total, available),
    ...(swapTotal !== undefined && swapFree !== undefined && { swap: { total: swapTotal, used: Math.max(0, swapTotal - swapFree) } }),
  };
}

/**
 * macOS: `vm_stat`. os.freemem() counts only the "free" pages there, which the kernel keeps few of on
 * purpose, so it would show the memory as nearly full all the time. Used is what Activity Monitor
 * counts: active, wired and compressed pages; the rest can be taken.
 */
export function parseVmStat(text: string, total: number): Memory | undefined {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (name: string) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)\\.`, "m"))?.[1]);
  const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
  if (!Number.isFinite(used) || !Number.isFinite(pageSize)) return undefined;
  return { total, available: Math.min(total, Math.max(0, total - used)) };
}

/** What the sampler reads from the computer; swapped in tests. */
export type StatsSources = {
  platform: NodeJS.Platform;
  cores: () => number;
  cpuTimes: () => CpuTimes;
  totalmem: () => number;
  freemem: () => number;
  meminfo: () => Promise<string>;
  vmStat: () => Promise<string>;
  /** Free and total bytes of the volume the runner's home is on. */
  disk: () => Promise<{ total: number; free: number }>;
  runnerMemory: () => number;
  now: () => Date;
};

const defaultSources = (): StatsSources => ({
  platform: platform(),
  cores: () => cpus().length,
  cpuTimes,
  totalmem,
  freemem,
  meminfo: () => readFile("/proc/meminfo", "utf8"),
  vmStat: async () => (await run("vm_stat", [], { timeout: 5000, env: childEnv() })).stdout,
  disk: async () => {
    const home = runnerHome();
    const fs = await statfs(home).catch(() => statfs(homedir()));
    return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
  },
  runnerMemory: () => process.memoryUsage.rss(),
  now: () => new Date(),
});

/**
 * Measures the computer for the Devices page: CPU since the last sample, memory, swap, the disk the
 * runner is on and how many CLIs it runs. Numbers only. Everything but the CPU reading is optional,
 * so a platform where one reading fails still reports the rest.
 */
export class StatsSampler {
  private readonly sources: StatsSources;
  private previous: CpuTimes | undefined;
  /** The last sample taken; what hello sends, so the Devices page has a figure right after a connect. */
  latest: RunnerStats | undefined;

  constructor(
    private readonly tasks: () => number,
    sources: Partial<StatsSources> = {},
  ) {
    this.sources = { ...defaultSources(), ...sources };
  }

  async sample(): Promise<RunnerStats> {
    const s = this.sources;
    const times = s.cpuTimes();
    const percent = this.previous ? cpuPercent(this.previous, times) : undefined;
    this.previous = times;
    const [memory, disk] = await Promise.all([this.memory(), s.disk().catch(() => undefined)]);
    const stats: RunnerStats = {
      at: s.now().toISOString(),
      cpu: { ...(percent !== undefined && { percent }), cores: Math.max(1, s.cores()) },
      memory: { total: memory.total, available: memory.available },
      ...(memory.swap && { swap: memory.swap }),
      ...(disk && Number.isFinite(disk.total) && Number.isFinite(disk.free) && { disk: { total: Math.round(disk.total), free: Math.round(disk.free) } }),
      tasks: this.tasks(),
      runnerMemory: s.runnerMemory(),
    };
    this.latest = stats;
    return stats;
  }

  private async memory(): Promise<Memory> {
    const s = this.sources;
    const total = s.totalmem();
    const fallback = { total, available: Math.min(total, s.freemem()) };
    try {
      if (s.platform === "linux") return parseMeminfo(await s.meminfo()) ?? fallback;
      if (s.platform === "darwin") return parseVmStat(await s.vmStat(), total) ?? fallback;
    } catch {
      // The OS's own figure, less exact, still says something.
    }
    return fallback;
  }
}
