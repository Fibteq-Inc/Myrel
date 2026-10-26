import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CliModelSettings } from "../../../../components/project-settings/cli-models";
import { GeneralSettings } from "../../../../components/project-settings/general";
import { GithubSettings } from "../../../../components/project-settings/github";
import { InviteSettings, MemberSettings } from "../../../../components/project-settings/members";
import { Section } from "../../../../components/settings-section";
import { Spinner } from "../../../../components/ui";
import { useProject } from "../../../../lib/project";
import { useSession } from "../../../../lib/session";
import { makeStyles, useColors } from "../../../../theme";

/**
 * A project's settings on the phone: general, model defaults on the computer, GitHub, members and
 * invites. Folders, connectors, skills and the model key stay on the web, one tap away.
 */
export default function ProjectSettingsScreen() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const project = useQuery({ queryKey: ["projects", server, projectId], queryFn: () => api.getProject(projectId) });
  const role = project.data?.role;
  const canManage = role === "owner" || role === "admin";

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: t("mobile.projectSettings") }} />
      {!role ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <Text style={styles.hint}>{t("projectSettings.youAre", { role: t(`role.${role}`) })}</Text>
          <GeneralSettings projectId={projectId} canManage={canManage} />
          <CliModelSettings projectId={projectId} canManage={canManage} />
          <GithubSettings projectId={projectId} canManage={canManage} />
          <MemberSettings projectId={projectId} myRole={role} />
          {canManage && <InviteSettings projectId={projectId} />}
          <Section title={t("mobile.projectSettingsMore")} hint={t("mobile.projectSettingsWeb")}>
            <Pressable
              accessibilityRole="link"
              onPress={() => void WebBrowser.openBrowserAsync(`${server}/settings/projects/${encodeURIComponent(projectId)}`)}
              style={styles.option}
            >
              <Text style={styles.value}>{t("mobile.openInBrowser")}</Text>
              <ExternalLink size={16} color={colors.subtle} />
            </Pressable>
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    page: { padding: 16, gap: 24, paddingBottom: 48 },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
    value: { color: colors.fg, fontSize: 15 },
  }),
);
