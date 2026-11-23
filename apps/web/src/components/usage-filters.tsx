import { COORDINATOR_HARNESS } from "@myrel/protocol";
import { localDay, USAGE_CLIS, USAGE_PRESETS, type UsageFilter, type UsagePreset } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { harnessName } from "./chat/message-stats";
import { Select } from "./ui/controls";
import { Segmented } from "./usage-dashboard";

/** One row above everything it scopes: when, which project (not inside one), which CLI, where and whose turns. */
export function UsageFilters({
  filter,
  onChange,
  projects,
  updating,
}: {
  filter: UsageFilter;
  onChange: (change: Partial<UsageFilter>) => void;
  /** The projects to pick from; absent inside a project. */
  projects?: { id: string; name: string }[];
  updating?: boolean;
}) {
  const t = useT();
  const today = localDay(new Date());
  const rangeLabel = (p: UsagePreset) =>
    p === "1" ? t("usage.rangeToday") : p === "month" ? t("usage.rangeMonth") : p === "custom" ? t("usage.rangeCustom") : t("usage.rangeDays", { count: Number(p) });
  const pick = (range: UsagePreset) =>
    onChange({
      range,
      // Starts from the last week, to be narrowed.
      ...(range === "custom" && !filter.from && { from: localDay(new Date(Date.now() - 6 * 86_400_000)), to: today }),
    });
  const select = "h-8 w-auto max-w-full text-[13px] sm:max-w-[200px]";
  const date = "h-8 rounded-lg border border-edge bg-raised px-2 text-[13px] text-fg outline-none focus:border-accent";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label={t("usage.range")} value={filter.range} options={USAGE_PRESETS.map((p) => ({ value: p, label: rangeLabel(p) }))} onChange={pick} />
      {filter.range === "custom" && (
        <span className="flex items-center gap-1.5 text-[13px] text-subtle">
          <input type="date" aria-label={t("usage.from")} value={filter.from ?? today} max={today} onChange={(e) => e.target.value && onChange({ from: e.target.value })} className={date} />
          <span aria-hidden="true">–</span>
          <input type="date" aria-label={t("usage.to")} value={filter.to ?? today} max={today} onChange={(e) => e.target.value && onChange({ to: e.target.value })} className={date} />
        </span>
      )}
      {projects && (
        <Select aria-label={t("usage.project")} value={filter.project ?? ""} onChange={(e) => onChange({ project: e.target.value || undefined })} className={select}>
          <option value="">{t("usage.allProjects")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      )}
      <Select aria-label={t("usage.cli")} value={filter.cli ?? ""} onChange={(e) => onChange({ cli: e.target.value || undefined })} className={select}>
        <option value="">{t("usage.allClis")}</option>
        {USAGE_CLIS.map((c) => (
          <option key={c} value={c}>
            {c === COORDINATOR_HARNESS ? t("usage.coordinator") : harnessName(c)}
          </option>
        ))}
      </Select>
      <Select
        aria-label={t("usage.where")}
        value={filter.runtime ?? ""}
        onChange={(e) => onChange({ runtime: (e.target.value || undefined) as UsageFilter["runtime"] })}
        className={select}
      >
        <option value="">{t("usage.anywhere")}</option>
        <option value="local">{t("usage.local")}</option>
        <option value="cloud">{t("usage.cloud")}</option>
      </Select>
      <Select aria-label={t("usage.scope")} value={filter.scope} onChange={(e) => onChange({ scope: e.target.value as UsageFilter["scope"] })} className={select}>
        <option value="all">{t("usage.everyone")}</option>
        <option value="mine">{t("usage.mine")}</option>
      </Select>
      {updating && <span className="text-xs text-subtle">{t("usage.updating")}</span>}
    </div>
  );
}
