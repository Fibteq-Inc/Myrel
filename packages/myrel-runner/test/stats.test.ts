import { RunnerStats } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { cpuPercent, cpuTimes, parseMeminfo, parseVmStat, StatsSampler, type StatsSources } from "../src/stats";

const MEMINFO = `MemTotal:       12219076 kB
MemFree:          401232 kB
MemAvailable:    1835476 kB
Buffers:           90304 kB
Cached:          2199176 kB
SwapCached:            0 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               98094.
Pages active:                            401222.
Pages inactive:                          378101.
Pages speculative:                         3261.
Pages throttled:                              0.
Pages wired down:                        118473.
Pages purgeable:                          12042.
"Translation faults":                 719047661.
Pages occupied by compressor:             63512.
Pages stored in compressor:              203471.
`;

const GB = 1024 ** 3;

describe("stats readings", () => {
  it("sums the cores' times and takes a percentage between two readings", () => {
    const core = (user: number, idle: number) => ({ model: "", speed: 0, times: { user, nice: 0, sys: 0, idle, irq: 0 } });
    const before = cpuTimes([core(100, 900), core(200, 800)]);
    const after = cpuTimes([core(400, 1100), core(300, 900)]);
    expect(before).toEqual({ idle: 1700, total: 2000 });
    // 700 units passed, of which 300 idle.
    expect(cpuPercent(before, after)).toBe(57.1);
    expect(cpuPercent(after, after)).toBeUndefined();
  });

  it("reads Linux's meminfo, including a computer without swap", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ total: 12219076 * 1024, available: 1835476 * 1024, swap: { total: 0, used: 0 } });
    expect(parseMeminfo("MemTotal: 10 kB\nMemFree: 4 kB\nSwapTotal: 8 kB\nSwapFree: 5 kB\n")).toEqual({
      total: 10240,
      available: 4096,
      swap: { total: 8192, used: 3072 },
    });
    expect(parseMeminfo("nothing here")).toBeUndefined();
  });

  it("reads macOS's vm_stat as Activity Monitor counts used memory", () => {
    const total = 16 * GB;
    const used = (401222 + 118473 + 63512) * 16384;
    expect(parseVmStat(VM_STAT, total)).toEqual({ total, available: total - used });
    expect(parseVmStat("garbage", total)).toBeUndefined();
  });
});

function sources(over: Partial<StatsSources> = {}): Partial<StatsSources> {
  let tick = 0;
  return {
    platform: "linux",
    cores: () => 4,
    cpuTimes: () => ({ idle: 1000 + 300 * tick, total: 1000 + 400 * tick++ }),
    totalmem: () => 12219076 * 1024,
    freemem: () => 401232 * 1024,
    meminfo: async () => MEMINFO,
    vmStat: async () => VM_STAT,
    disk: async () => ({ total: 500 * GB, free: 118 * GB }),
    runnerMemory: () => 80_000_000,
    now: () => new Date("2026-11-01T12:00:00Z"),
    ...over,
  };
}

describe("StatsSampler", () => {
  it("gives the CPU percentage from the second sample on, and fits the protocol", async () => {
    const sampler = new StatsSampler(() => 2, sources());
    const first = await sampler.sample();
    expect(first.cpu).toEqual({ cores: 4 });
    expect(first).toMatchObject({
      memory: { total: 12219076 * 1024, available: 1835476 * 1024 },
      swap: { total: 0, used: 0 },
      disk: { total: 500 * GB, free: 118 * GB },
      tasks: 2,
      runnerMemory: 80_000_000,
      at: "2026-11-01T12:00:00.000Z",
    });
    const second = await sampler.sample();
    // 400 units passed, 300 of them idle.
    expect(second.cpu).toEqual({ percent: 25, cores: 4 });
    expect(sampler.latest).toBe(second);
    expect(RunnerStats.parse(second)).toEqual(second);
  });

  it("uses vm_stat on macOS and falls back to the OS figure when a reading fails", async () => {
    const mac = new StatsSampler(() => 0, sources({ platform: "darwin", totalmem: () => 16 * GB }));
    const used = (401222 + 118473 + 63512) * 16384;
    expect((await mac.sample()).memory).toEqual({ total: 16 * GB, available: 16 * GB - used });
    expect((await mac.sample()).swap).toBeUndefined();

    const broken = new StatsSampler(() => 0, sources({ meminfo: () => Promise.reject(new Error("EACCES")), disk: () => Promise.reject(new Error("ENOENT")) }));
    const stats = await broken.sample();
    expect(stats.memory).toEqual({ total: 12219076 * 1024, available: 401232 * 1024 });
    expect(stats.disk).toBeUndefined();

    const windows = new StatsSampler(() => 0, sources({ platform: "win32", totalmem: () => 32 * GB, freemem: () => 20 * GB }));
    expect((await windows.sample()).memory).toEqual({ total: 32 * GB, available: 20 * GB });
  });

  it("measures this computer", async () => {
    const stats = await new StatsSampler(() => 0).sample();
    expect(RunnerStats.parse(stats)).toEqual(stats);
    expect(stats.memory.total).toBeGreaterThan(0);
    expect(stats.memory.available).toBeLessThanOrEqual(stats.memory.total);
    expect(stats.cpu.cores).toBeGreaterThan(0);
  });
});
