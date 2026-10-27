import { useT } from "@myrel/i18n/react";
import { ProjectColor, ProjectIcon } from "@myrel/protocol";
import {
  BookOpen,
  Bot,
  Briefcase,
  Camera,
  ChartLine,
  Check,
  Code,
  Cpu,
  Database,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  Heart,
  House,
  Leaf,
  type LucideIcon,
  Music,
  Palette,
  PenTool,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Smartphone,
  Star,
  Terminal,
  Zap,
} from "lucide-react";
import { cn } from "../lib/ui";

export const PROJECT_ICONS: Record<ProjectIcon, LucideIcon> = {
  folder: Folder,
  rocket: Rocket,
  code: Code,
  terminal: Terminal,
  globe: Globe,
  smartphone: Smartphone,
  server: Server,
  database: Database,
  cpu: Cpu,
  bot: Bot,
  book: BookOpen,
  pen: PenTool,
  palette: Palette,
  camera: Camera,
  music: Music,
  gamepad: Gamepad2,
  briefcase: Briefcase,
  cart: ShoppingCart,
  chart: ChartLine,
  shield: Shield,
  flask: FlaskConical,
  leaf: Leaf,
  heart: Heart,
  star: Star,
  zap: Zap,
  home: House,
};

/** The mark and the fill behind it, from the theme's --project-* variables (styles.css). */
function tint(color: ProjectColor | null | undefined) {
  const c = color && ProjectColor.safeParse(color).success ? color : "indigo";
  return { color: `var(--project-${c})`, backgroundColor: `var(--project-${c}-soft)` };
}

/** A project's icon, or its first letter, on a square in its color. */
export function ProjectBadge({
  name,
  icon,
  color,
  size = 28,
}: {
  name: string;
  icon?: ProjectIcon | null;
  color?: ProjectColor | null;
  size?: number;
}) {
  // An icon a newer server knows but this app does not falls back to the letter.
  const Icon = icon ? PROJECT_ICONS[icon] : undefined;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), ...tint(color) }}
      className="flex flex-none items-center justify-center rounded-lg font-semibold"
    >
      {Icon ? <Icon size={Math.round(size * 0.54)} strokeWidth={2} /> : (name.trim()[0]?.toLocaleUpperCase() ?? "?")}
    </span>
  );
}

/** Picks a project's icon and color in its settings, with the badge as it will look. */
export function ProjectLookPicker({
  name,
  icon,
  color,
  onIcon,
  onColor,
  disabled,
}: {
  name: string;
  icon: ProjectIcon | null;
  color: ProjectColor | null;
  onIcon: (icon: ProjectIcon | null) => void;
  onColor: (color: ProjectColor | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const option = (selected: boolean) =>
    cn(
      "flex size-9 items-center justify-center rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60",
      selected ? "border-edge-strong bg-selected" : "border-transparent hover:bg-hover",
    );
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <ProjectBadge name={name} icon={icon} color={color} size={56} />
      <div className="min-w-0 flex-1 space-y-4">
        <fieldset className="space-y-1.5" disabled={disabled}>
          <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("projectSettings.color")}</legend>
          <div className="flex flex-wrap gap-1">
            {[null, ...ProjectColor.options].map((c) => {
              const selected = c === color;
              const label = c ? t(`projectColor.${c}`) : t("projectSettings.colorDefault");
              return (
                <button
                  key={c ?? "default"}
                  type="button"
                  aria-pressed={selected}
                  aria-label={label}
                  title={label}
                  onClick={() => onColor(c)}
                  className={option(selected)}
                >
                  <span
                    className="flex size-6 items-center justify-center rounded-full"
                    style={{ backgroundColor: `var(--project-${c ?? "indigo"})` }}
                  >
                    {selected && <Check size={14} strokeWidth={3} style={{ color: `var(--project-${c ?? "indigo"}-soft)` }} />}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="space-y-1.5" disabled={disabled}>
          <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("projectSettings.icon")}</legend>
          <div className="flex flex-wrap gap-1">
            {[null, ...ProjectIcon.options].map((i) => {
              const selected = i === icon;
              const label = i ? t(`projectIcon.${i}`) : t("projectSettings.iconLetter");
              const Icon = i ? PROJECT_ICONS[i] : null;
              return (
                <button
                  key={i ?? "letter"}
                  type="button"
                  aria-pressed={selected}
                  aria-label={label}
                  title={label}
                  onClick={() => onIcon(i)}
                  className={cn(option(selected), selected ? "text-fg" : "text-muted hover:text-fg")}
                >
                  {Icon ? (
                    <Icon size={18} />
                  ) : (
                    <span className="text-[15px] font-semibold">{name.trim()[0]?.toLocaleUpperCase() ?? "?"}</span>
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
