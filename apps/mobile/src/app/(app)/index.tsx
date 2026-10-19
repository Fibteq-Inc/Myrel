import type { Project } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Href, Stack, useRouter } from "expo-router";
import { ChevronRight, FolderClosed, LogOut, Plus } from "lucide-react-native";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Button, errorMessage, Input, relativeTime, Spinner } from "../../components/ui";
import { useSession } from "../../lib/session";
import { colors, radius } from "../../theme";

export default function ProjectsScreen() {
  const { api, user, server, signOut } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects", server], queryFn: () => api.listProjects() });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (projectName: string) => api.createProject({ name: projectName }),
    onSuccess: (project) => {
      setCreating(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["projects", server] });
      router.push(`/projects/${project.id}` as Href);
    },
  });

  function confirmSignOut() {
    Alert.alert("Sign out?", `You are signed in as ${user?.email}.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 18 }}>
              <Pressable accessibilityLabel="New project" hitSlop={10} onPress={() => setCreating((v) => !v)}>
                <Plus size={22} color={colors.fg} />
              </Pressable>
              <Pressable accessibilityLabel="Sign out" hitSlop={10} onPress={confirmSignOut}>
                <LogOut size={20} color={colors.subtle} />
              </Pressable>
            </View>
          ),
        }}
      />
      <FlatList<Project>
        contentInsetAdjustmentBehavior="automatic"
        data={projects.data ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={projects.isRefetching}
            onRefresh={() => void projects.refetch()}
            tintColor={colors.subtle}
          />
        }
        ListHeaderComponent={
          creating ? (
            <View style={styles.create}>
              <Input
                value={name}
                onChangeText={setName}
                placeholder="Project name"
                autoFocus
                autoCapitalize="sentences"
                returnKeyType="done"
                onSubmitEditing={() => name.trim() && create.mutate(name.trim())}
              />
              {create.error && <Text style={styles.error}>{errorMessage(create.error)}</Text>}
              <Button onPress={() => create.mutate(name.trim())} pending={create.isPending} disabled={!name.trim()}>
                Create project
              </Button>
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          projects.isPending ? (
            <View style={styles.empty}>
              <Spinner size={22} color={colors.subtle} />
            </View>
          ) : projects.error ? (
            <View style={styles.empty}>
              <Text style={styles.error}>{errorMessage(projects.error)}</Text>
              <Button variant="ghost" onPress={() => void projects.refetch()}>
                Try again
              </Button>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No projects yet</Text>
              <Text style={styles.emptyHint}>Create one to start working with Altair.</Text>
              <Button onPress={() => setCreating(true)}>New project</Button>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/projects/${item.id}` as Href)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}
          >
            <View style={styles.icon}>
              <FolderClosed size={18} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.meta}>
                {item.role === "owner" ? "Owner" : "Member"} · {relativeTime(item.createdAt)}
              </Text>
            </View>
            <ChevronRight size={16} color={colors.subtle} />
          </Pressable>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 8, flexGrow: 1 },
  create: { gap: 10, marginBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { color: colors.fg, fontSize: 16, fontWeight: "600" },
  meta: { color: colors.subtle, fontSize: 13 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 48 },
  emptyTitle: { color: colors.fg, fontSize: 18, fontWeight: "600" },
  emptyHint: { color: colors.subtle, fontSize: 14 },
  error: { color: colors.bad, fontSize: 14 },
});
