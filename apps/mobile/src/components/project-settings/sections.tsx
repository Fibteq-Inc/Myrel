import type { MessageKey } from "@myrel/i18n";
import { BookMarked, Folder, FolderGit2, type LucideIcon, Plug, Settings2, Sparkles, Users } from "lucide-react-native";

/** The project settings' sections, in the web's tab order (apps/web/src/components/project-settings.tsx). */
export const PROJECT_SETTINGS_SECTIONS = ["general", "model", "folders", "github", "connectors", "skills", "members"] as const;
export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[number];

export const SECTION_INFO: Record<ProjectSettingsSection, { label: MessageKey; icon: LucideIcon }> = {
  general: { label: "projectSettings.tab.general", icon: Settings2 },
  model: { label: "projectSettings.tab.model", icon: Sparkles },
  folders: { label: "projectSettings.tab.folders", icon: Folder },
  github: { label: "projectSettings.tab.github", icon: FolderGit2 },
  connectors: { label: "projectSettings.tab.connectors", icon: Plug },
  skills: { label: "settings.skills", icon: BookMarked },
  members: { label: "projectSettings.tab.members", icon: Users },
};

export function isSection(value: string | undefined): value is ProjectSettingsSection {
  return (PROJECT_SETTINGS_SECTIONS as readonly string[]).includes(value ?? "");
}
