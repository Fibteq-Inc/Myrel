import {
  DOCS_URL,
  STARTER_EXAMPLES,
  type StarterExample,
  type StarterStep,
  starterDraft,
  starterSteps,
} from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Me } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { Check, ChevronDown, ChevronRight, Clock, LayoutTemplate, type LucideIcon, Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { runnersQueryKey } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { makeStyles, radius, useColors } from "../../theme";

const ICONS: Record<StarterExample, LucideIcon> = { page: LayoutTemplate, research: Search, routine: Clock };

/** Example tasks under an empty project chat; a tap puts one in the message box, it is not sent. */
export function StarterExamples({ onPick }: { onPick: (text: string, select: [number, number]) => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.examples}>
      {STARTER_EXAMPLES.map((id) => {
        const Icon = ICONS[id];
        return (
          <Pressable
            key={id}
            accessibilityRole="button"
            onPress={() => {
              const draft = starterDraft(t(`starter.${id}.prompt`));
              onPick(draft.text, draft.select);
            }}
            style={({ pressed }) => [styles.example, pressed && { backgroundColor: colors.hover }]}
          >
            <Icon size={16} color={colors.accent} />
            <Text style={styles.exampleTitle}>{t(`starter.${id}.title`)}</Text>
            <ChevronRight size={16} color={colors.subtle} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The owner's "Get started" list, as on the web: until every step is done or
 * they hide it (once for the account, on every device). Null while it does not apply.
 */
function useStarter(projectId: string, owner: boolean, asked: boolean) {
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const meKey = ["me", server];
  const me = useQuery({ queryKey: meKey, queryFn: () => api.getMe() });
  const on = owner && me.data?.onboarded === false;
  const runners = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: on });
  const github = useQuery({ queryKey: ["github", server], queryFn: () => api.getGithubStatus(), enabled: on });
  const configured = github.data?.configured;
  const repos = useQuery({
    queryKey: ["repos", server, projectId],
    queryFn: () => api.listProjectRepos(projectId),
    enabled: on && !!configured,
  });
  const finish = useMutation({
    mutationFn: () => api.markOnboarded(),
    onSuccess: () => queryClient.setQueryData<Me>(meKey, (old) => old && { ...old, onboarded: true }),
  });

  const steps =
    on && runners.data && github.data && (!configured || repos.data)
      ? starterSteps({ asked, computers: runners.data.length, github: configured ? repos.data!.length > 0 : null })
      : null;
  const complete = !!steps?.every((s) => s.done);
  const { mutate, isIdle } = finish;
  useEffect(() => {
    if (complete && isIdle) mutate();
  }, [complete, isIdle, mutate]);

  if (!steps || complete || !finish.isIdle) return null;
  return { steps, hide: () => finish.mutate() };
}

/** The list: open in an empty chat, folded to one line above the conversation once it has messages. */
export function StarterList({
  projectId,
  owner,
  asked,
  folded = false,
}: {
  projectId: string;
  owner: boolean;
  asked: boolean;
  folded?: boolean;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const starter = useStarter(projectId, owner, asked);
  const [open, setOpen] = useState(!folded);
  if (!starter) return null;
  const done = starter.steps.filter((s) => s.done).length;
  const total = starter.steps.length;

  return (
    <View style={[styles.list, folded && styles.folded]}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("starter.open", { done, total })}
          accessibilityState={{ expanded: open }}
          disabled={!folded}
          onPress={() => setOpen((o) => !o)}
          style={styles.headTitle}
        >
          <Text style={styles.title}>{t("starter.title")}</Text>
          <Text style={styles.subtle}>{t("starter.progress", { done, total })}</Text>
          {folded && (
            <ChevronDown size={14} color={colors.subtle} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
          )}
        </Pressable>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={starter.hide}>
          <Text style={styles.subtle}>{t("starter.hide")}</Text>
        </Pressable>
      </View>
      {open && starter.steps.map((step) => <StepRow key={step.id} step={step} />)}
    </View>
  );
}

function StepRow({ step }: { step: StarterStep }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  // Pairing a computer and connecting GitHub happen on a computer, so the phone points to the guide.
  const guide = step.id === "computer" ? "/computer/connect/" : step.id === "github" ? "/github/connect/" : null;
  const hint = step.id === "computer" ? t("starter.step.computerHintMobile") : null;

  return (
    <View style={styles.step}>
      <View style={[styles.dot, step.done && { backgroundColor: colors.ok, borderColor: colors.ok }]}>
        {step.done && <Check size={11} strokeWidth={3.5} color={colors.ground} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.label, step.done && styles.labelDone]}>{t(`starter.step.${step.id}`)}</Text>
        {hint && !step.done && <Text style={styles.subtle}>{hint}</Text>}
      </View>
      {guide && !step.done && (
        <Pressable
          accessibilityRole="link"
          onPress={() => void WebBrowser.openBrowserAsync(DOCS_URL + guide)}
          style={({ pressed }) => [styles.how, pressed && { backgroundColor: colors.hover }]}
        >
          <Text style={styles.howText}>{t("starter.how")}</Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    examples: { alignSelf: "stretch", gap: 8, marginTop: 12 },
    example: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    exampleTitle: { flex: 1, color: colors.fg, fontSize: 15, fontWeight: "500" },
    list: {
      alignSelf: "stretch",
      marginTop: 16,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      overflow: "hidden",
    },
    folded: { marginTop: 8, marginHorizontal: 12 },
    head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
    headTitle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
    title: { color: colors.fg, fontSize: 14, fontWeight: "600" },
    subtle: { color: colors.subtle, fontSize: 13 },
    step: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    dot: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 1.5,
      borderColor: colors.edge,
      alignItems: "center",
      justifyContent: "center",
    },
    label: { color: colors.fg, fontSize: 14 },
    labelDone: { color: colors.subtle, textDecorationLine: "line-through" },
    how: { borderWidth: 1, borderColor: colors.edge, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 5 },
    howText: { color: colors.fg, fontSize: 13 },
  }),
);
