import { projectChat, threadByCard, threadReplyCount } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import type { CliId } from "@myrel/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AskCliPicker, OfferedClis, usePickableClis } from "../../../../components/cli-picker";
import type { ComposerHandle } from "../../../../components/composer";
import { Conversation } from "../../../../components/conversation";
import { ArtifactsTab } from "../../../../components/project/artifacts-tab";
import { FilesTab } from "../../../../components/project/files-tab";
import { StarterExamples, StarterList } from "../../../../components/project/starter";
import { Tabs } from "../../../../components/project/tabs";
import { ThreadsTab } from "../../../../components/project/threads-tab";
import { UsageTab } from "../../../../components/project/usage-tab";
import { ThreadCard } from "../../../../components/thread-card";
import { useProject } from "../../../../lib/project";
import { useSession } from "../../../../lib/session";
import { useNames } from "../../../../lib/use-names";
import { makeStyles } from "../../../../theme";

type Tab = "chat" | "threads" | "artifacts" | "files" | "usage";

/** A project: its conversation and the Threads, Artifacts, Files and Usage tabs, as on the web. */
export default function ProjectScreen() {
  const t = useT();
  const styles = useStyles();
  const { api, server } = useSession();
  const { projectId, status } = useProject();
  const project = useQuery({ queryKey: ["projects", server, projectId], queryFn: () => api.getProject(projectId) });
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.title}>
              <Text style={styles.titleText} numberOfLines={1}>
                {project.data?.name ?? ""}
              </Text>
              {status !== "open" && (
                <Text style={styles.status}>
                  {status === "connecting" ? t("connection.connecting") : t("connection.closed")}
                </Text>
              )}
            </View>
          ),
        }}
      />
      <Tabs<Tab>
        label={t("tabs.label")}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "chat", label: t("tabs.chat") },
          { key: "threads", label: t("sidebar.threads") },
          { key: "artifacts", label: t("sidebar.artifacts") },
          { key: "files", label: t("tabs.files") },
          { key: "usage", label: t("tabs.usage") },
        ]}
      />
      {tab === "chat" ? (
        <ChatTab owner={project.data?.role === "owner"} />
      ) : tab === "threads" ? (
        <ThreadsTab />
      ) : tab === "artifacts" ? (
        <ArtifactsTab />
      ) : tab === "files" ? (
        <FilesTab />
      ) : (
        <UsageTab />
      )}
    </View>
  );
}

function ChatTab({ owner }: { owner: boolean }) {
  const t = useT();
  const styles = useStyles();
  const { user } = useSession();
  const { projectId, state, status, send } = useProject();
  const names = useNames(projectId);
  const messages = useMemo(() => projectChat(state), [state]);
  const threads = useMemo(() => threadByCard(state), [state]);
  // The CLIs the next ask's thread may run with; each ask picks its own.
  const pickable = usePickableClis(projectId);
  const [clis, setClis] = useState<CliId[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const asked = messages.length > 0;
  const onSend = useCallback(
    (body: string, attachments?: string[]) => {
      send(body, null, attachments, pickable ? clis : []);
      setClis([]);
    },
    [send, pickable, clis],
  );

  return (
    <Conversation
      projectId={projectId}
      messages={messages}
      me={user?.id ?? ""}
      names={names}
      reactions={state.reactions}
      artifacts={state.artifacts}
      working={state.active[""] ? (state.progress[""] ?? t("message.thinking")) : null}
      placeholder={t("chat.placeholder")}
      onSend={onSend}
      tools={pickable && <AskCliPicker pickable={pickable} value={clis} onChange={setClis} />}
      composer={composer}
      header={asked ? <StarterList projectId={projectId} owner={owner} asked folded /> : undefined}
      footerFor={(m) => {
        const thread = threads.get(m.id);
        const offered = m.clis?.length ? <OfferedClis clis={m.clis} /> : null;
        if (!thread) return offered;
        return (
          <>
            {offered}
            <ThreadCard projectId={projectId} thread={thread} replies={threadReplyCount(state, thread.id)} />
          </>
        );
      }}
      empty={
        status === "open" ? (
          <View style={{ alignItems: "center", alignSelf: "stretch", gap: 6, paddingHorizontal: 8 }}>
            <Text style={styles.emptyTitle}>{t("chat.emptyTitle")}</Text>
            <Text style={styles.emptyHint}>{t("starter.try")}</Text>
            <StarterExamples onPick={(text, select) => composer.current?.fill(text, select)} />
            <StarterList projectId={projectId} owner={owner} asked={false} />
          </View>
        ) : null
      }
    />
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    title: { alignItems: "center" },
    titleText: { color: colors.fg, fontSize: 17, fontWeight: "600", maxWidth: 240 },
    status: { color: colors.subtle, fontSize: 12 },
    emptyTitle: { color: colors.fg, fontSize: 18, fontWeight: "600", textAlign: "center" },
    emptyHint: { color: colors.subtle, fontSize: 14, lineHeight: 20, textAlign: "center" },
  }),
);
