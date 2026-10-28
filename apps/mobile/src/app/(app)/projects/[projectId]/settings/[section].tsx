import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { CliModelSettings } from "../../../../../components/project-settings/cli-models";
import { ConnectorSettings } from "../../../../../components/project-settings/connectors";
import { FolderSettings } from "../../../../../components/project-settings/folders";
import { DeleteProject, GeneralSettings } from "../../../../../components/project-settings/general";
import { GithubSettings } from "../../../../../components/project-settings/github";
import { InviteSettings, MemberSettings } from "../../../../../components/project-settings/members";
import { ModelSettings } from "../../../../../components/project-settings/model";
import { isSection, SECTION_INFO } from "../../../../../components/project-settings/sections";
import { SkillSettings } from "../../../../../components/project-settings/skills";
import { Spinner } from "../../../../../components/ui";
import { useProject } from "../../../../../lib/project";
import { useSession } from "../../../../../lib/session";
import { makeStyles } from "../../../../../theme";

/** One section of a project's settings, as one tab of the web's project settings. */
export default function ProjectSettingsSectionScreen() {
  const t = useT();
  const styles = useStyles();
  const { section } = useLocalSearchParams<{ section: string }>();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const project = useQuery({ queryKey: ["projects", server, projectId], queryFn: () => api.getProject(projectId) });
  const p = project.data;
  const known = isSection(section) ? section : "general";
  const canManage = p?.role === "owner" || p?.role === "admin";

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: t(SECTION_INFO[known].label) }} />
      {!p ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          {known === "general" && (
            <>
              <GeneralSettings projectId={projectId} canManage={canManage} />
              {p.role === "owner" && <DeleteProject projectId={projectId} name={p.name} />}
            </>
          )}
          {known === "model" && (
            <>
              <ModelSettings projectId={projectId} canManage={canManage} />
              <CliModelSettings projectId={projectId} canManage={canManage} />
            </>
          )}
          {known === "folders" && <FolderSettings project={p} canManage={canManage} />}
          {known === "github" && <GithubSettings projectId={projectId} canManage={canManage} />}
          {known === "connectors" && <ConnectorSettings projectId={projectId} canManage={canManage} />}
          {known === "skills" && <SkillSettings projectId={projectId} canManage={canManage} />}
          {known === "members" && (
            <>
              <MemberSettings projectId={projectId} myRole={p.role} />
              {canManage && <InviteSettings projectId={projectId} />}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles(() =>
  StyleSheet.create({
    page: { padding: 16, gap: 24, paddingBottom: 48 },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
  }),
);
