import type { ProjectColor, ProjectIcon } from "@myrel/protocol";
import {
  BookOpen,
  Bot,
  Briefcase,
  Camera,
  ChartLine,
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
} from "lucide-react-native";
import { Text, View } from "react-native";
import { projectColors, useTheme } from "../theme";

/** The same icons as the web's components/project-badge.tsx. */
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

/** A project's icon, or its first letter, on a square in its color. */
export function ProjectBadge({
  name,
  icon,
  color,
  size = 36,
}: {
  name: string;
  icon?: ProjectIcon | null;
  color?: ProjectColor | null;
  size?: number;
}) {
  const palette = projectColors[useTheme()];
  // A color or icon a newer server knows but this app does not falls back to the default.
  const tint = (color && palette[color]) || palette.indigo;
  const Icon = icon ? PROJECT_ICONS[icon] : undefined;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        backgroundColor: tint.soft,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {Icon ? (
        <Icon size={Math.round(size * 0.5)} color={tint.mark} />
      ) : (
        <Text style={{ color: tint.mark, fontSize: Math.round(size * 0.46), fontWeight: "600" }}>
          {name.trim()[0]?.toLocaleUpperCase() ?? "?"}
        </Text>
      )}
    </View>
  );
}
