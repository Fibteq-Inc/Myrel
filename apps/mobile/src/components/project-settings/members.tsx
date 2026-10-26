import { useT } from "@myrel/i18n/react";
import { InviteRole, type Member, type ProjectRole } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Href, useRouter } from "expo-router";
import { ChevronDown, X } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../lib/session";
import { makeStyles, radius, useColors } from "../../theme";
import { Option, Sheet } from "../cli-picker";
import { Notice, Section } from "../settings-section";
import { Button, errorMessage, Input } from "../ui";

const roleKey = (role: ProjectRole) => `role.${role}` as const;

/** The project's members: roles, removing and leaving, as on the web. */
export function MemberSettings({ projectId, myRole }: { projectId: string; myRole: ProjectRole }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { api, server, user } = useSession();
  const queryClient = useQueryClient();
  const key = ["projects", server, projectId, "members"];
  const { data: members = [] } = useQuery({ queryKey: key, queryFn: () => api.listMembers(projectId) });
  const [picking, setPicking] = useState<Member | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => api.updateMemberRole(projectId, userId, role),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(projectId, userId),
    onSuccess: async (_, userId) => {
      if (userId !== user?.id) return refresh();
      await queryClient.invalidateQueries({ queryKey: ["projects", server] });
      router.dismissTo("/" as Href);
    },
  });

  const canManage = myRole === "owner" || myRole === "admin";
  const roleOptions: ProjectRole[] = myRole === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];

  function confirmRemove(m: Member, isMe: boolean) {
    const action = isMe ? t("members.leave") : t("members.remove");
    Alert.alert(isMe ? t("members.leaveConfirm") : t("members.removeConfirm", { name: m.name }), undefined, [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: action, style: "destructive", onPress: () => remove.mutate(m.id) },
    ]);
  }

  return (
    <Section title={t("members.title")} hint={t("members.description")}>
      {members.length === 0 && <Text style={styles.sub}>{t("members.empty")}</Text>}
      {members.map((m) => {
        const isMe = m.id === user?.id;
        const editable = canManage && !isMe && (m.role !== "owner" || myRole === "owner");
        return (
          <View key={m.id} style={styles.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>
                {m.name}
                {isMe && <Text style={styles.sub}>{`  ${t("members.you")}`}</Text>}
              </Text>
              {m.email && (
                <Text style={styles.sub} numberOfLines={1}>
                  {m.email}
                </Text>
              )}
            </View>
            {editable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("members.roleOf", { name: m.name })}
                hitSlop={6}
                disabled={setRole.isPending}
                onPress={() => setPicking(m)}
                style={styles.role}
              >
                <Text style={styles.roleText}>{t(roleKey(m.role))}</Text>
                <ChevronDown size={13} color={colors.subtle} />
              </Pressable>
            ) : (
              <Text style={styles.sub}>{t(roleKey(m.role))}</Text>
            )}
            {(editable || isMe) && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isMe ? t("members.leave") : t("members.removeLabel", { name: m.name })}
                hitSlop={8}
                disabled={remove.isPending}
                onPress={() => confirmRemove(m, isMe)}
              >
                <X size={16} color={colors.subtle} />
              </Pressable>
            )}
          </View>
        );
      })}
      {(setRole.error || remove.error) && <Notice tone="bad">{errorMessage(setRole.error ?? remove.error, t("common.error"))}</Notice>}

      <Sheet open={!!picking} onClose={() => setPicking(null)} title={picking ? t("members.roleOf", { name: picking.name }) : ""}>
        {roleOptions.map((r) => (
          <Option
            key={r}
            kind="radio"
            checked={picking?.role === r}
            title={t(roleKey(r))}
            onPress={() => {
              if (picking && picking.role !== r) setRole.mutate({ userId: picking.id, role: r });
              setPicking(null);
            }}
          />
        ))}
      </Sheet>
    </Section>
  );
}

/** Owners and admins: invite by email and revoke pending invitations. */
export function InviteSettings({ projectId }: { projectId: string }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = ["projects", server, projectId, "invites"];
  const { data: invites = [] } = useQuery({ queryKey: key, queryFn: () => api.listProjectInvites(projectId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const invite = useMutation({
    mutationFn: () => api.invite(projectId, { email: email.trim(), role }),
    onSuccess: () => {
      setEmail("");
      return refresh();
    },
    // The invite can be saved even when its email fails: show it in the list either way.
    onError: refresh,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvite(projectId, id), onSuccess: refresh });

  return (
    <Section title={t("projectInvites.title")} hint={t("projectInvites.description")}>
      <View style={{ gap: 10 }}>
        <Input
          value={email}
          onChangeText={setEmail}
          placeholder="name@example.com"
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          returnKeyType="send"
          onSubmitEditing={() => email.trim() && invite.mutate()}
        />
        <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={t("projectInvites.role")}>
          {InviteRole.options.map((r) => {
            const on = role === r;
            return (
              <Pressable
                key={r}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setRole(r)}
                style={[styles.choice, on && { borderColor: colors.accent, backgroundColor: colors.accentSoft }]}
              >
                <Text style={[styles.choiceText, on && { color: colors.fg }]}>{t(roleKey(r))}</Text>
              </Pressable>
            );
          })}
        </View>
        <Button onPress={() => invite.mutate()} pending={invite.isPending} disabled={!email.trim()}>
          {t("projectInvites.invite")}
        </Button>
        {invite.error && <Notice tone="bad">{errorMessage(invite.error, t("common.error"))}</Notice>}
      </View>
      {invites.map((i) => (
        <View key={i.id} style={styles.row}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name} numberOfLines={1}>
              {i.email}
            </Text>
            <Text style={styles.sub}>{t("projectInvites.pending", { role: t(roleKey(i.role)), name: i.invitedBy })}</Text>
          </View>
          <Pressable accessibilityRole="button" hitSlop={6} disabled={revoke.isPending} onPress={() => revoke.mutate(i.id)}>
            <Text style={[styles.roleText, { color: colors.bad }]}>{t("projectInvites.revoke")}</Text>
          </Pressable>
        </View>
      ))}
    </Section>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
    name: { color: colors.fg, fontSize: 15 },
    sub: { color: colors.subtle, fontSize: 13 },
    role: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
    roleText: { color: colors.muted, fontSize: 14 },
    choices: { flexDirection: "row", gap: 8 },
    choice: { flex: 1, alignItems: "center", borderWidth: 1, borderColor: colors.edge, borderRadius: radius.md, paddingVertical: 10 },
    choiceText: { color: colors.muted, fontSize: 14, fontWeight: "500" },
  }),
);
