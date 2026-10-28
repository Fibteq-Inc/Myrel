import { useT } from "@myrel/i18n/react";
import type { Connector } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Globe, LogIn, Pencil, Plus, RefreshCw, ShieldCheck, SquareTerminal, Store, Trash2, Wrench } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Notice, Section } from "../settings-section";
import { errorMessage, Spinner } from "../ui";
import {
  Catalog,
  ConnectorForm,
  connectorError,
  type Draft,
  draftFromConnector,
  emptyDraft,
  FullSheet,
  OfficialBadge,
  openSignIn,
  SmallButton,
} from "./connector-form";

/**
 * The project's MCP connectors, as on the web's Connectors tab: the list with status and tools,
 * the catalog, adding by URL or command, and the person's own connectors switched on here.
 * Sign-ins open in the browser; coming back to the app reads the list again.
 */
export function ConnectorSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = ["projects", server, projectId, "connectors"];
  const query = useQuery({ queryKey: key, queryFn: () => api.listConnectors(projectId) });
  const connectors = query.data ?? [];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ["projects", server, projectId, "personal"] });
  };
  const [adding, setAdding] = useState<Draft | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void queryClient.invalidateQueries({ queryKey: ["projects", server, projectId, "connectors"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", server, projectId, "personal"] });
    });
    return () => sub.remove();
  }, [queryClient, server, projectId]);

  const opened = connectors.find((c) => c.id === open);

  return (
    <>
      <Section title={t("connectors.projectTitle")} hint={t("connectors.projectDescription")}>
        {query.isPending ? (
          <View style={styles.center}>
            <Spinner />
          </View>
        ) : query.error ? (
          <Notice tone="bad">{connectorError(query.error, t)}</Notice>
        ) : connectors.length === 0 ? (
          <Text style={styles.sub}>{t("connectors.projectEmpty")}</Text>
        ) : (
          connectors.map((c) => <ConnectorRow key={c.id} connector={c} projectId={projectId} queryKey={key} onOpen={() => setOpen(c.id)} />)
        )}
        {canManage && (
          <View style={styles.actions}>
            <SmallButton icon={<Store size={14} color={colors.fg} />} label={t("connectors.catalog")} onPress={() => setCatalog(true)} />
            <SmallButton icon={<Plus size={14} color={colors.fg} />} label={t("connectors.add")} onPress={() => setAdding(emptyDraft())} />
          </View>
        )}
      </Section>

      <PersonalConnectors projectId={projectId} />

      {catalog && (
        <Catalog
          connectors={connectors}
          projectId={projectId}
          onClose={() => setCatalog(false)}
          onSetUp={(draft) => {
            setCatalog(false);
            setAdding(draft);
          }}
          onAdded={(signIn) => {
            setCatalog(false);
            if (signIn) void openSignIn(signIn, refresh);
            else refresh();
          }}
        />
      )}
      {adding && (
        <ConnectorForm
          key={adding.key}
          initial={adding}
          projectId={projectId}
          onCancel={() => setAdding(null)}
          onDone={(_, signIn) => {
            setAdding(null);
            if (signIn) void openSignIn(signIn, refresh);
            else refresh();
          }}
        />
      )}
      {opened && <ConnectorDetail connector={opened} projectId={projectId} queryKey={key} onClose={() => setOpen(null)} />}
    </>
  );
}

function ConnectorIcon({ connector: c }: { connector: Connector }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.icon}>
      {c.transport === "http" ? <Globe size={17} color={colors.muted} /> : <SquareTerminal size={17} color={colors.muted} />}
    </View>
  );
}

/** One connector: name, type and status, its switch, and a sign-in button when it needs one. A tap opens its details. */
function ConnectorRow({
  connector: c,
  projectId,
  queryKey,
  onOpen,
}: {
  connector: Connector;
  projectId: string;
  queryKey: unknown[];
  onOpen: () => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const replace = (next: Connector) => queryClient.setQueryData<Connector[]>(queryKey, (list) => list?.map((x) => (x.id === next.id ? next : x)));
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.updateConnector(c.id, { enabled }, projectId), onSuccess: replace });
  const signIn = useMutation({
    mutationFn: () => api.authorizeConnector(c.id, projectId),
    onSuccess: (url) => openSignIn(url, () => void queryClient.invalidateQueries({ queryKey })),
  });
  const error = toggle.error ?? signIn.error;

  return (
    <View style={{ paddingVertical: 6 }}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("connectors.showDetails")}
          onPress={onOpen}
          style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}
        >
          <ConnectorIcon connector={c} />
          <View style={{ flex: 1, gap: 2, opacity: c.enabled ? 1 : 0.6 }}>
            <View style={styles.titleRow}>
              <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>
                {c.name}
              </Text>
              {c.official && <OfficialBadge />}
            </View>
            <Text style={styles.sub} numberOfLines={1}>
              {c.transport === "http" ? t("connectors.type.http") : t("connectors.type.stdio")} · <Status connector={c} />
            </Text>
          </View>
          <ChevronRight size={16} color={colors.subtle} />
        </Pressable>
        {c.canEdit && (
          <Switch
            value={c.enabled}
            disabled={toggle.isPending}
            onValueChange={(on) => toggle.mutate(on)}
            accessibilityLabel={t("connectors.enabledLabel", { name: c.name })}
            trackColor={{ true: colors.accent, false: colors.edge }}
            thumbColor={colors.raised}
            ios_backgroundColor={colors.edge}
          />
        )}
      </View>
      {c.enabled && c.status === "needs_auth" && c.canEdit && (
        <View style={styles.rowExtra}>
          <SmallButton
            icon={signIn.isPending ? <Spinner size={14} /> : <LogIn size={14} color={colors.fg} />}
            label={t("connectors.signIn")}
            disabled={signIn.isPending}
            onPress={() => signIn.mutate()}
          />
        </View>
      )}
      {c.status === "error" && c.lastError && c.enabled && <Text style={[styles.rowExtra, styles.bad]}>{c.lastError}</Text>}
      {error && <Text style={[styles.rowExtra, styles.bad]}>{connectorError(error, t)}</Text>}
    </View>
  );
}

function Status({ connector: c }: { connector: Connector }) {
  const t = useT();
  const colors = useColors();
  if (!c.enabled) return <Text>{t("connectors.off")}</Text>;
  switch (c.status) {
    case "ok":
      return (
        <Text style={{ color: colors.ok }}>
          {c.tools.length > 0 ? t("connectors.status.okTools", { count: c.tools.length }) : t("connectors.status.ok")}
        </Text>
      );
    case "needs_auth":
      return <Text style={{ color: colors.warn }}>{t("connectors.status.needsAuth")}</Text>;
    case "error":
      return <Text style={{ color: colors.bad }}>{t("connectors.status.error")}</Text>;
    default:
      return <Text>{c.transport === "stdio" ? t("connectors.status.startsWithAgent") : t("connectors.status.unknown")}</Text>;
  }
}

function firstLine(text: string) {
  const line = text.split("\n")[0]!.trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/** A connector's details: its address, stored secret names and tools, and the actions the web's menu has. */
function ConnectorDetail({
  connector: c,
  projectId,
  queryKey,
  onClose,
}: {
  connector: Connector;
  projectId: string;
  queryKey: unknown[];
  onClose: () => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const replace = (next: Connector) => queryClient.setQueryData<Connector[]>(queryKey, (list) => list?.map((x) => (x.id === next.id ? next : x)));
  const check = useMutation({ mutationFn: () => api.checkConnector(c.id, projectId), onSuccess: replace });
  const signIn = useMutation({
    mutationFn: () => api.authorizeConnector(c.id, projectId),
    onSuccess: (url) => openSignIn(url, () => void queryClient.invalidateQueries({ queryKey })),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteConnector(c.id, projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      onClose();
    },
  });
  const error = check.error ?? signIn.error ?? remove.error;
  const details = c.transport === "http" ? c.url : [c.command, ...c.args].join(" ");

  if (editing) {
    return (
      <ConnectorForm
        initial={draftFromConnector(c)}
        existing={c}
        projectId={projectId}
        onCancel={() => setEditing(false)}
        onDone={(next) => {
          if (next) replace(next);
          setEditing(false);
        }}
      />
    );
  }

  const confirmDelete = () =>
    Alert.alert(t("connectors.deleteConfirm", { name: c.name }), t("connectors.deleteBodyProject"), [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: t("connectors.delete"), style: "destructive", onPress: () => remove.mutate() },
    ]);

  return (
    <FullSheet title={c.name} onClose={onClose}>
      <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
        <View style={styles.titleRow}>
          <ConnectorIcon connector={c} />
          <Text style={styles.sub}>
            {c.transport === "http" ? t("connectors.type.http") : t("connectors.type.stdio")} · <Status connector={c} />
          </Text>
          {c.official && <OfficialBadge />}
          <Text style={styles.slug}>{c.slug}</Text>
        </View>
        {details ? (
          <Text style={styles.code} selectable>
            {details}
          </Text>
        ) : null}
        {c.status === "error" && c.lastError && c.enabled && <Text style={styles.bad}>{c.lastError}</Text>}
        {c.secretNames.length > 0 && (
          <View style={styles.titleRow}>
            <ShieldCheck size={13} color={colors.subtle} />
            <Text style={styles.sub}>{c.transport === "http" ? t("connectors.storedHeaders") : t("connectors.storedEnv")}</Text>
            {c.secretNames.map((n) => (
              <Text key={n} style={styles.slug}>
                {n}
              </Text>
            ))}
          </View>
        )}

        {c.canEdit && (
          <View style={styles.actions}>
            {c.auth === "oauth" && (
              <SmallButton
                icon={signIn.isPending ? <Spinner size={14} /> : <LogIn size={14} color={colors.fg} />}
                label={c.status === "needs_auth" ? t("connectors.signIn") : t("connectors.signInAgain")}
                disabled={signIn.isPending}
                onPress={() => signIn.mutate()}
              />
            )}
            {c.transport === "http" && (
              <SmallButton
                icon={check.isPending ? <Spinner size={14} /> : <RefreshCw size={14} color={colors.fg} />}
                label={c.status === "error" || c.status === "unknown" ? t("connectors.retry") : t("connectors.refreshTools")}
                disabled={check.isPending}
                onPress={() => check.mutate()}
              />
            )}
            <SmallButton icon={<Pencil size={14} color={colors.fg} />} label={t("connectors.edit")} onPress={() => setEditing(true)} />
            <SmallButton icon={<Trash2 size={14} color={colors.bad} />} label={t("connectors.delete")} disabled={remove.isPending} onPress={confirmDelete} />
          </View>
        )}
        {error && <Notice tone="bad">{connectorError(error, t)}</Notice>}

        <View style={{ gap: 8 }}>
          <Text style={styles.label}>{t("connectors.tools")}</Text>
          {c.tools.length > 0 ? (
            c.tools.map((tool) => (
              <View key={tool.name} style={{ flexDirection: "row", gap: 8 }}>
                <Wrench size={12} color={colors.subtle} style={{ marginTop: 3 }} />
                <Text style={[styles.sub, { flex: 1 }]}>
                  <Text style={styles.toolName}>{tool.name}</Text>
                  {tool.description ? `  ${firstLine(tool.description)}` : ""}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.sub}>{c.transport === "stdio" ? t("connectors.toolsUnknown") : t("connectors.noTools")}</Text>
          )}
        </View>
      </ScrollView>
    </FullSheet>
  );
}

/** The person's own connectors, each switched on or off for this project (they start off), as on the web. */
function PersonalConnectors({ projectId }: { projectId: string }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = ["projects", server, projectId, "personal"];
  const query = useQuery({ queryKey: key, queryFn: () => api.getPersonalInProject(projectId) });
  type Personal = Awaited<ReturnType<typeof api.getPersonalInProject>>;
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setPersonalInProject(projectId, "connectors", id, on),
    onMutate: ({ id, on }) =>
      queryClient.setQueryData<Personal>(key, (data) => data && { ...data, connectors: data.connectors.map((c) => (c.id === id ? { ...c, inProject: on } : c)) }),
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const items = query.data?.connectors ?? [];

  return (
    <Section title={t("personalInProject.connectorsTitle")} hint={t("personalInProject.connectorsDescription")}>
      {query.isPending ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : query.error ? (
        <Notice tone="bad">{errorMessage(query.error, t("common.error"))}</Notice>
      ) : items.length === 0 ? (
        <Text style={styles.sub}>{t("personalInProject.noConnectors")}</Text>
      ) : (
        items.map((c) => (
          <View key={c.id} style={[styles.row, { paddingVertical: 8 }]}>
            <View style={styles.icon}>
              {c.transport === "http" ? <Globe size={15} color={colors.muted} /> : <SquareTerminal size={15} color={colors.muted} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>
                {c.name}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {c.enabled ? (c.transport === "http" ? (c.url ?? "") : [c.command, ...c.args].join(" ")) : t("personalInProject.offEverywhere")}
              </Text>
            </View>
            <Switch
              value={c.inProject}
              disabled={toggle.isPending}
              onValueChange={(on) => toggle.mutate({ id: c.id, on })}
              accessibilityLabel={t("personalInProject.useHere", { name: c.name })}
              trackColor={{ true: colors.accent, false: colors.edge }}
              thumbColor={colors.raised}
              ios_backgroundColor={colors.edge}
            />
          </View>
        ))
      )}
      {toggle.error && <Notice tone="bad">{errorMessage(toggle.error, t("common.error"))}</Notice>}
    </Section>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { alignItems: "center", paddingVertical: 16 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
    rowExtra: { marginLeft: 48, marginTop: 6, alignSelf: "flex-start" },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
    icon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.hover, alignItems: "center", justifyContent: "center" },
    name: { color: colors.fg, fontSize: 15, fontWeight: "500" },
    sub: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    label: { color: colors.muted, fontSize: 13, fontWeight: "600" },
    bad: { color: colors.bad, fontSize: 12 },
    slug: { color: colors.subtle, fontFamily: mono, fontSize: 11, backgroundColor: colors.hover, borderRadius: radius.sm, paddingHorizontal: 4 },
    code: { color: colors.subtle, fontFamily: mono, fontSize: 12 },
    toolName: { color: colors.body, fontFamily: mono, fontSize: 12 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  }),
);
