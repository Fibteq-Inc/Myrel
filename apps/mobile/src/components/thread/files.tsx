import { useT } from "@myrel/i18n/react";
import type { Task } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderTree, GitCommitHorizontal } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Empty } from "../project/empty";
import { Spinner } from "../ui";

/**
 * What the thread's cloud tasks saved in its workspace: browse folders, read a
 * file, and see the saves. Refreshes when a task finishes.
 */
export function WorkspaceFilesTab({ projectId, threadId, tasks }: { projectId: string; threadId: string; tasks: Task[] }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const { api, server } = useSession();
  const [path, setPath] = useState("");
  const lastDone = tasks.filter((task) => task.status !== "running").at(-1)?.id ?? null;
  const { data, isPending, error } = useQuery({
    queryKey: ["threadFiles", server, projectId, threadId, path, lastDone],
    queryFn: () => api.threadFiles(projectId, threadId, path),
  });

  if (isPending) {
    return (
      <View style={styles.center}>
        <Spinner size={22} color={colors.subtle} />
      </View>
    );
  }
  if (error) return <Empty title={t("files.workspaceError")} />;
  if (!data) {
    return (
      <Empty
        icon={<FolderTree size={22} color={colors.subtle} />}
        title={t("files.workspaceEmpty")}
        body={t("files.workspaceEmptyBody")}
      />
    );
  }

  const parts = path.split("/").filter(Boolean);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View accessibilityLabel={t("files.workspacePath")} style={styles.crumbs}>
        <Crumb label={t("files.workspaceRoot")} onPress={() => setPath("")} />
        {parts.map((part, i) => (
          <View key={i} style={styles.crumbs}>
            <ChevronRight size={12} color={colors.subtle} />
            <Crumb label={part} mono onPress={() => setPath(parts.slice(0, i + 1).join("/"))} />
          </View>
        ))}
      </View>

      {data.file ? (
        data.file.text === null ? (
          <Text style={styles.hint}>{t("files.workspaceBinary", { size: String(data.file.size) })}</Text>
        ) : (
          <View style={{ gap: 6 }}>
            <ScrollView horizontal style={styles.code} contentContainerStyle={{ padding: 10 }}>
              <Text selectable style={styles.codeText}>
                {data.file.text}
              </Text>
            </ScrollView>
            {data.file.truncated && <Text style={styles.hint}>{t("files.workspaceTruncated")}</Text>}
          </View>
        )
      ) : data.entries ? (
        data.entries.length === 0 ? (
          <Text style={styles.hint}>{t("files.workspaceEmptyFolder")}</Text>
        ) : (
          <View>
            {data.entries.map((e) => (
              <Pressable
                key={e.path}
                accessibilityRole="button"
                onPress={() => setPath(e.path)}
                style={({ pressed }) => [styles.entry, pressed && { backgroundColor: colors.hover }]}
              >
                {e.type === "folder" ? <Folder size={15} color={colors.accent} /> : <File size={15} color={colors.subtle} />}
                <Text style={styles.entryText} numberOfLines={1}>
                  {e.name}
                </Text>
              </Pressable>
            ))}
          </View>
        )
      ) : (
        <Text style={styles.hint}>{t("files.workspaceMissing")}</Text>
      )}

      {data.commits.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={styles.section}>{t("files.workspaceHistory")}</Text>
          {data.commits.map((c) => (
            <View key={c.hash} style={styles.commit}>
              <GitCommitHorizontal size={14} color={colors.subtle} />
              <Text style={styles.commitText} numberOfLines={1}>
                {c.message}
              </Text>
              <Text style={styles.hint}>{new Date(c.at).toLocaleDateString()}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Crumb({ label, mono: isMono = false, onPress }: { label: string; mono?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6}>
      <Text style={[styles.crumb, isMono && { fontFamily: mono, fontSize: 12.5 }]}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    page: { padding: 16, gap: 16 },
    crumbs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
    crumb: { color: colors.muted, fontSize: 13 },
    hint: { color: colors.subtle, fontSize: 12 },
    code: { maxHeight: 480, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.console },
    codeText: { fontFamily: mono, fontSize: 11.5, lineHeight: 17, color: colors.body },
    entry: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 9, borderRadius: radius.sm },
    entryText: { flex: 1, color: colors.fg, fontFamily: mono, fontSize: 12.5 },
    section: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
    commit: { flexDirection: "row", alignItems: "center", gap: 8 },
    commitText: { flex: 1, color: colors.muted, fontSize: 13 },
  }),
);
