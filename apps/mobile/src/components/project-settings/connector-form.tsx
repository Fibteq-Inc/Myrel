import { ApiError } from "@myrel/client";
import type { MessageKey, Translate } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import {
  CATALOG_CATEGORIES,
  type CatalogCategory,
  type CatalogConnector,
  CONNECTOR_PRESETS,
  type Connector,
  type ConnectorPreset,
  type ConnectorRunsOn,
  type CreateConnectorInput,
  ENV_NAME,
  HEADER_NAME,
  type UpdateConnectorInput,
} from "@myrel/protocol";
import { keepPreviousData, useInfiniteQuery, useMutation } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { Check, ExternalLink, KeyRound, LogIn, Plus, Search, ShieldCheck, Sparkles, SquareTerminal, X } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Notice } from "../settings-section";
import { Button, errorMessage, Input, Spinner } from "../ui";

/** Translations of the presets' descriptions; a preset missing here shows its own English text. */
const PRESET_DESCRIPTIONS: Record<string, MessageKey> = {
  "fibteq-flow": "connectors.preset.fibteqFlow",
  "fibteq-flow-apps": "connectors.preset.fibteqFlowApps",
  sentry: "connectors.preset.sentry",
  postgres: "connectors.preset.postgres",
};

const RUNS_ON: { value: ConnectorRunsOn; label: MessageKey }[] = [
  { value: "cloud", label: "connectors.runsOn.cloud" },
  { value: "local", label: "connectors.runsOn.local" },
  { value: "both", label: "connectors.runsOn.both" },
];

const CATEGORY_LABELS: Record<CatalogCategory, MessageKey> = {
  developer: "connectors.category.developer",
  productivity: "connectors.category.productivity",
  communication: "connectors.category.communication",
  design: "connectors.category.design",
  data: "connectors.category.data",
  sales: "connectors.category.sales",
  finance: "connectors.category.finance",
  search: "connectors.category.search",
  ai: "connectors.category.ai",
  other: "connectors.category.other",
};

/** The message for a failed connector call: the server's own message, else the first invalid field (as on the web). */
export function connectorError(err: unknown, t: Translate) {
  if (err instanceof ApiError && typeof err.body === "object" && err.body) {
    const body = err.body as { message?: unknown; issues?: { path?: unknown[]; code?: string; message?: string }[] };
    if (typeof body.message === "string" && body.message) return body.message;
    const issue = body.issues?.[0];
    if (issue?.message) return issue.path?.length && issue.code !== "invalid_key" ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    return t("connectors.invalid");
  }
  return errorMessage(err, t("common.error"));
}

/**
 * Opens a connector's sign-in in the browser. The server's callback finishes it without a Myrel
 * session in that browser (it asks to confirm whose connector it is); `after` reads the list again.
 */
export async function openSignIn(url: string, after: () => void) {
  await WebBrowser.openBrowserAsync(url).catch(() => {});
  after();
}

// --- drafts ---

type Pair = { id: number; key: string; value: string; placeholder?: string; stored?: boolean };

export type Draft = {
  key: number;
  name: string;
  transport: "http" | "stdio";
  url: string;
  auth: "oauth" | "headers";
  headers: Pair[];
  command: string;
  args: string;
  env: Pair[];
  runsOn: ConnectorRunsOn;
};

let nextId = 1;
const pair = (key = "", value = "", extra: Partial<Pair> = {}): Pair => ({ id: nextId++, key, value, ...extra });

export function emptyDraft(): Draft {
  return {
    key: nextId++,
    name: "",
    transport: "http",
    url: "",
    auth: "oauth",
    headers: [pair("Authorization", "")],
    command: "",
    args: "",
    env: [],
    runsOn: "both",
  };
}

function draftFromPreset(p: ConnectorPreset): Draft {
  const base = { ...emptyDraft(), name: p.name };
  if (p.transport === "http") {
    return {
      ...base,
      url: p.url,
      auth: p.auth,
      headers: p.headerHint ? [pair(p.headerHint.name, "", { placeholder: p.headerHint.placeholder })] : base.headers,
    };
  }
  return {
    ...base,
    transport: "stdio",
    command: p.command,
    args: p.args.join("\n"),
    env: (p.envHint ?? []).map((h) => pair(h.name, "", { placeholder: h.placeholder })),
    runsOn: p.runsOn,
  };
}

function draftFromCatalog(e: CatalogConnector): Draft {
  return {
    ...emptyDraft(),
    name: e.title.slice(0, 60),
    url: e.url,
    auth: "headers",
    headers: [pair(e.headerHint?.name ?? "Authorization", "", { placeholder: e.headerHint?.placeholder })],
  };
}

export function draftFromConnector(c: Connector): Draft {
  const stored = c.secretNames.map((n) => pair(n, "", { stored: true }));
  return {
    key: nextId++,
    name: c.name,
    transport: c.transport,
    url: c.url ?? "",
    auth: c.auth === "oauth" ? "oauth" : "headers",
    headers: c.transport === "http" ? stored : [],
    command: c.command ?? "",
    args: c.args.join("\n"),
    env: c.transport === "stdio" ? stored : [],
    runsOn: c.runsOn,
  };
}

const missingValue = (p: Pair) => !!p.key.trim() && !p.value && !p.stored;
const toMap = (pairs: Pair[]) => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

// --- a full-height sheet ---

export function FullSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose}>
            <Text style={[styles.name, { color: colors.accent }]}>{t("common.close")}</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

// --- add and edit ---

/** Adds a connector, or edits `existing`, in a full-height sheet, as the web's form does. */
export function ConnectorForm({
  initial,
  existing,
  projectId,
  onDone,
  onCancel,
}: {
  initial: Draft;
  existing?: Connector;
  projectId: string;
  /** `signIn` is the sign-in link of a new OAuth connector, to open once the sheet is gone. */
  onDone: (connector?: Connector, signIn?: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const styles = useStyles();
  const { api } = useSession();
  const [d, setD] = useState(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const editing = !!existing;
  const oauth = d.transport === "http" && d.auth === "oauth";
  const args = d.args
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);

  const save = useMutation({
    mutationFn: async (): Promise<{ connector?: Connector; signIn?: string }> => {
      if (existing) {
        const input: UpdateConnectorInput = { name: d.name.trim() };
        if (d.transport === "http") {
          input.url = d.url.trim();
          if (existing.auth !== "oauth") input.secrets = toMap(d.headers);
        } else {
          input.command = d.command.trim();
          input.args = args;
          input.runsOn = d.runsOn;
          input.secrets = toMap(d.env);
        }
        return { connector: await api.updateConnector(existing.id, input, projectId) };
      }
      const input: CreateConnectorInput =
        d.transport === "http"
          ? { transport: "http", name: d.name.trim(), url: d.url.trim(), auth: d.auth, headers: oauth ? {} : toMap(d.headers) }
          : { transport: "stdio", name: d.name.trim(), command: d.command.trim(), args, env: toMap(d.env), runsOn: d.runsOn };
      const res = await api.createConnector(input, projectId);
      return { connector: res.connector, signIn: res.authorizeUrl };
    },
    onSuccess: (res) => onDone(res.connector, res.signIn),
  });

  const pairs = d.transport === "http" ? (oauth ? [] : d.headers) : d.env;
  const nameRule = d.transport === "http" ? HEADER_NAME : ENV_NAME;
  const badName = pairs.some((p) => p.key.trim() && !nameRule.test(p.key.trim()));
  const valid = !badName && !!d.name.trim() && (d.transport === "http" ? /^https:\/\/\S+$/.test(d.url.trim()) : !!d.command.trim());

  return (
    <FullSheet title={editing ? t("connectors.edit") : t("connectors.addTitle")} onClose={onCancel}>
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
        {!editing && <Text style={styles.sub}>{t("connectors.addHelp")}</Text>}

        <Field label={t("connectors.name")}>
          <Input value={d.name} onChangeText={(v) => set("name", v)} placeholder={t("connectors.namePlaceholder")} maxLength={60} autoCapitalize="words" />
        </Field>

        {!editing && (
          <Field label={t("connectors.type")}>
            <Segmented
              value={d.transport}
              onChange={(v) => set("transport", v)}
              options={[
                { value: "http", label: t("connectors.type.http") },
                { value: "stdio", label: t("connectors.type.stdio") },
              ]}
            />
          </Field>
        )}

        {d.transport === "http" ? (
          <>
            <Field label={t("connectors.url")}>
              <Input value={d.url} onChangeText={(v) => set("url", v)} placeholder="https://mcp.example.com/mcp" keyboardType="url" />
            </Field>
            {!editing && (
              <Field label={t("connectors.auth")}>
                <Segmented
                  value={d.auth}
                  onChange={(v) => set("auth", v)}
                  options={[
                    { value: "oauth", label: t("connectors.auth.oauth") },
                    { value: "headers", label: t("connectors.auth.headers") },
                  ]}
                />
                <Text style={styles.sub}>{d.auth === "oauth" ? t("connectors.auth.oauthHint") : t("connectors.auth.headersHint")}</Text>
              </Field>
            )}
            {!oauth && (
              <PairsEditor
                label={t("connectors.headers")}
                addLabel={t("connectors.addHeader")}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer …"
                pairs={d.headers}
                nameRule={HEADER_NAME}
                badNameHint={t("connectors.badHeaderName")}
                onChange={(v) => set("headers", v)}
              />
            )}
          </>
        ) : (
          <>
            <Field label={t("connectors.command")}>
              <Input value={d.command} onChangeText={(v) => set("command", v)} placeholder="npx" style={{ fontFamily: mono }} />
            </Field>
            <Field label={t("connectors.args")} hint={t("connectors.argsHint")}>
              <Input
                value={d.args}
                onChangeText={(v) => set("args", v)}
                multiline
                placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                style={{ fontFamily: mono, fontSize: 13, minHeight: 88, paddingTop: 10, textAlignVertical: "top" }}
              />
            </Field>
            <PairsEditor
              label={t("connectors.env")}
              addLabel={t("connectors.addEnv")}
              keyPlaceholder="API_KEY"
              valuePlaceholder={t("connectors.valuePlaceholder")}
              pairs={d.env}
              nameRule={ENV_NAME}
              badNameHint={t("connectors.badEnvName")}
              onChange={(v) => set("env", v)}
            />
            <Field label={t("connectors.runsOn")}>
              <Segmented value={d.runsOn} onChange={(v) => set("runsOn", v)} options={RUNS_ON.map((r) => ({ value: r.value, label: t(r.label) }))} />
            </Field>
          </>
        )}

        {editing && existing.auth === "oauth" && <Text style={styles.sub}>{t("connectors.oauthEditHint")}</Text>}

        <Button onPress={() => valid && save.mutate()} pending={save.isPending} disabled={!valid}>
          {editing ? t("settings.saveChanges") : oauth ? t("connectors.addAndSignIn") : t("connectors.addButton")}
        </Button>
        {save.error && <Notice tone="bad">{connectorError(save.error, t)}</Notice>}
      </ScrollView>
    </FullSheet>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint && <Text style={styles.sub}>{hint}</Text>}
    </View>
  );
}

/** Two or three choices side by side, in place of a select. */
function Segmented<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: colors.hover, borderColor: colors.edge }]}
          >
            <Text style={[styles.segmentText, on && { color: colors.fg }]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Name/value rows for headers or environment variables; values are masked. */
function PairsEditor({
  label,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  pairs,
  nameRule,
  badNameHint,
  onChange,
}: {
  label: string;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  pairs: Pair[];
  nameRule: RegExp;
  badNameHint: string;
  onChange: (pairs: Pair[]) => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const update = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  // A whole pasted line ("api-key: abc123", "API_KEY=abc123") in the name box is split, as on the web.
  const setName = (i: number, text: string) => {
    const line = /^\s*([A-Za-z_][\w-]*)\s*[:=]\s*(\S.*?)\s*$/.exec(text);
    update(i, line && !pairs[i]!.value ? { key: line[1]!, value: line[2]! } : { key: text });
  };
  const bad = pairs.filter((p) => p.key.trim() && !nameRule.test(p.key.trim()));
  const empty = pairs.filter(missingValue);
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      {pairs.map((p, i) => (
        <View key={p.id} style={styles.pair}>
          <View style={{ flex: 1, gap: 6 }}>
            <Input
              value={p.key}
              onChangeText={(v) => setName(i, v)}
              placeholder={keyPlaceholder}
              accessibilityLabel={t("connectors.pairName")}
              style={styles.pairInput}
            />
            <Input
              value={p.value}
              onChangeText={(v) => update(i, { value: v })}
              secureTextEntry
              placeholder={p.stored ? t("connectors.storedValue") : (p.placeholder ?? valuePlaceholder)}
              accessibilityLabel={t("connectors.pairValue", { name: p.key || keyPlaceholder })}
              style={styles.pairInput}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("connectors.removePair", { name: p.key || keyPlaceholder })}
            hitSlop={8}
            onPress={() => onChange(pairs.filter((_, j) => j !== i))}
          >
            <X size={16} color={colors.subtle} />
          </Pressable>
        </View>
      ))}
      {bad.length > 0 && <Notice tone="bad">{badNameHint}</Notice>}
      {empty.length > 0 && <Notice>{t("connectors.missingValue", { name: empty.map((p) => p.key.trim()).join(", ") })}</Notice>}
      <Pressable accessibilityRole="button" onPress={() => onChange([...pairs, pair()])} style={styles.addPair}>
        <Plus size={14} color={colors.accent} />
        <Text style={{ color: colors.accent, fontSize: 14 }}>{addLabel}</Text>
      </Pressable>
    </View>
  );
}

// --- the catalog ---

type Offer = { kind: "preset"; preset: ConnectorPreset } | { kind: "registry"; entry: CatalogConnector };

/** Myrel's presets and the MCP Registry's servers, searchable by name and category, as on the web. */
export function Catalog({
  connectors,
  projectId,
  onAdded,
  onSetUp,
  onClose,
}: {
  connectors: Connector[];
  projectId: string;
  /** A one-tap OAuth connector was added; `signIn` is its sign-in link. */
  onAdded: (signIn?: string) => void;
  onSetUp: (draft: Draft) => void;
  onClose: () => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<CatalogCategory | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const query = useInfiniteQuery({
    queryKey: ["connector-catalog", server, q, category],
    queryFn: ({ pageParam }) => api.searchConnectorCatalog(q, pageParam, category ?? undefined),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  const entries = query.data?.pages.flatMap((p) => p.connectors) ?? [];
  const syncedAt = query.data?.pages[0]?.syncedAt;
  const counts = new Map(query.data?.pages[0]?.categories.map((c) => [c.id, c.count]));

  const matches = (p: ConnectorPreset) => !q || `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase());
  const recommended = !category ? CONNECTOR_PRESETS.filter((p) => p.featured && matches(p)) : [];
  const extras = CONNECTOR_PRESETS.filter((p) => !p.featured && (!category || p.category === category) && matches(p));
  const offers: Offer[] = [
    ...recommended.map((preset): Offer => ({ kind: "preset", preset })),
    ...entries.filter((e) => e.official).map((entry): Offer => ({ kind: "registry", entry })),
    ...extras.map((preset): Offer => ({ kind: "preset", preset })),
    ...entries.filter((e) => !e.official).map((entry): Offer => ({ kind: "registry", entry })),
  ];

  const connect = useMutation({
    mutationFn: (o: { key: string; name: string; url: string }) =>
      api.createConnector({ transport: "http", name: o.name.slice(0, 60), url: o.url, auth: "oauth" }, projectId),
    onSuccess: (res) => onAdded(res.authorizeUrl),
  });

  const card = (o: Offer) => {
    const p = o.kind === "preset" ? o.preset : null;
    const e = o.kind === "registry" ? o.entry : null;
    const key = p ? `preset:${p.id}` : e!.id;
    const name = p ? p.name : e!.title;
    const url = p ? (p.transport === "http" ? p.url : null) : e!.url;
    const description = p ? (PRESET_DESCRIPTIONS[p.id] ? t(PRESET_DESCRIPTIONS[p.id]!) : p.description) : e!.description || e!.id;
    const signsIn = p ? p.transport === "http" && p.auth === "oauth" : e!.auth === "oauth";
    const added = !!url && connectors.some((c) => c.url === url);
    const busy = connect.isPending && connect.variables?.key === key;
    return (
      <View key={key} style={[styles.card, p?.featured && { borderColor: colors.accentLine, backgroundColor: colors.accentWash }]}>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={[styles.icon, p?.featured && { backgroundColor: colors.accent }]}>
            {p?.transport === "stdio" ? (
              <SquareTerminal size={17} color={colors.muted} />
            ) : (
              <Text style={[styles.iconText, p?.featured && { color: colors.onAccent }]}>{name.slice(0, 1).toUpperCase()}</Text>
            )}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <View style={styles.titleRow}>
              <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>
                {name}
              </Text>
              {p?.featured && (
                <View style={[styles.badge, { backgroundColor: colors.accentSoft }]}>
                  <Sparkles size={11} color={colors.accent} />
                  <Text style={[styles.badgeText, { color: colors.accent }]}>{t("connectors.featured")}</Text>
                </View>
              )}
              {e?.official && <OfficialBadge />}
            </View>
            <Text style={styles.sub} numberOfLines={2}>
              {description}
            </Text>
          </View>
        </View>
        <View style={styles.cardFoot}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
            {p?.transport === "stdio" ? (
              <Text style={styles.small}>{t("connectors.type.stdio")}</Text>
            ) : (
              !signsIn && (
                <View style={styles.inline}>
                  <KeyRound size={11} color={colors.subtle} />
                  <Text style={styles.small}>{t("connectors.catalogNeedsKey")}</Text>
                </View>
              )
            )}
            {e?.websiteUrl && (
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(e.websiteUrl!)} style={styles.inline}>
                <ExternalLink size={11} color={colors.subtle} />
                <Text style={styles.small}>{t("connectors.catalogWebsite")}</Text>
              </Pressable>
            )}
          </View>
          {added ? (
            <View style={styles.inline}>
              <Check size={14} color={colors.ok} />
              <Text style={{ color: colors.ok, fontSize: 13 }}>{t("connectors.added")}</Text>
            </View>
          ) : signsIn && url ? (
            <SmallButton
              icon={busy ? <Spinner size={14} /> : <LogIn size={14} color={colors.fg} />}
              label={t("connectors.connect")}
              disabled={connect.isPending}
              onPress={() => connect.mutate({ key, name, url })}
            />
          ) : (
            <SmallButton icon={<Plus size={14} color={colors.fg} />} label={t("connectors.setUp")} onPress={() => onSetUp(p ? draftFromPreset(p) : draftFromCatalog(e!))} />
          )}
        </View>
      </View>
    );
  };

  return (
    <FullSheet title={t("connectors.catalog")} onClose={onClose}>
      <View>
        <View style={styles.searchIcon} pointerEvents="none">
          <Search size={15} color={colors.subtle} />
        </View>
        <Input value={text} onChangeText={setText} placeholder={t("connectors.catalogSearch")} accessibilityLabel={t("connectors.catalogSearch")} style={{ paddingLeft: 36 }} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
        <Chip active={!category} label={t("connectors.category.all")} onPress={() => setCategory(null)} />
        {CATALOG_CATEGORIES.map((c) => (
          <Chip key={c} active={category === c} label={t(CATEGORY_LABELS[c])} count={counts.get(c)} onPress={() => setCategory(c)} />
        ))}
      </ScrollView>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 16 }}>
        <Text style={styles.sub}>{t("connectors.catalogDescription")}</Text>
        {connect.error && <Notice tone="bad">{connectorError(connect.error, t)}</Notice>}
        {query.isPending ? (
          <View style={{ alignItems: "center", paddingVertical: 16 }}>
            <Spinner />
          </View>
        ) : query.error ? (
          <Notice tone="bad">{connectorError(query.error, t)}</Notice>
        ) : offers.length === 0 ? (
          <Text style={[styles.sub, { textAlign: "center", paddingVertical: 16 }]}>
            {!syncedAt && !q && !category ? t("connectors.catalogFilling") : t("connectors.catalogEmpty", { q })}
          </Text>
        ) : (
          <View style={{ gap: 10, opacity: query.isPlaceholderData ? 0.6 : 1 }}>{offers.map(card)}</View>
        )}
        {query.hasNextPage && (
          <Button variant="ghost" onPress={() => void query.fetchNextPage()} pending={query.isFetchingNextPage}>
            {t("connectors.catalogMore")}
          </Button>
        )}
      </ScrollView>
    </FullSheet>
  );
}

/** Marks one of the official servers; the mark comes from Myrel's own list. */
export function OfficialBadge() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={[styles.badge, { backgroundColor: colors.okSoft }]}>
      <ShieldCheck size={11} color={colors.ok} />
      <Text style={[styles.badgeText, { color: colors.ok }]}>{t("connectors.official")}</Text>
    </View>
  );
}

export function SmallButton({ icon, label, onPress, disabled }: { icon?: ReactNode; label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.smallButton, pressed && { backgroundColor: colors.hover }, disabled && { opacity: 0.5 }]}
    >
      {icon}
      <Text style={styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

function Chip({ active, label, count, onPress }: { active: boolean; label: string; count?: number; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: colors.fg, borderColor: colors.fg }]}
    >
      <Text style={[styles.chipText, active && { color: colors.ground }]}>
        {label}
        {count !== undefined ? ` ${count.toLocaleString()}` : ""}
      </Text>
    </Pressable>
  );
}

export const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    sheet: { flex: 1, gap: 12, backgroundColor: colors.ground, padding: 16 },
    sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    sheetTitle: { flex: 1, color: colors.fg, fontSize: 17, fontWeight: "600" },
    name: { color: colors.fg, fontSize: 15 },
    label: { color: colors.muted, fontSize: 13, fontWeight: "500" },
    sub: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    small: { color: colors.subtle, fontSize: 12 },
    segmented: { flexDirection: "row", gap: 4, borderRadius: radius.md, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.raised, padding: 3 },
    segment: { flex: 1, alignItems: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: "transparent", paddingVertical: 8, paddingHorizontal: 6 },
    segmentText: { color: colors.muted, fontSize: 13 },
    pair: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
    pairInput: { fontFamily: mono, fontSize: 13, minHeight: 40 },
    addPair: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
    card: { gap: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panel, padding: 14 },
    cardFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
    icon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.hover, alignItems: "center", justifyContent: "center" },
    iconText: { color: colors.muted, fontSize: 14, fontWeight: "600" },
    badge: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2 },
    badgeText: { fontSize: 11, fontWeight: "500" },
    inline: { flexDirection: "row", alignItems: "center", gap: 4 },
    smallButton: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.edge, paddingHorizontal: 10, paddingVertical: 6 },
    smallButtonText: { color: colors.fg, fontSize: 13, fontWeight: "500" },
    chip: { borderRadius: 999, borderWidth: 1, borderColor: colors.edge, paddingHorizontal: 12, paddingVertical: 6 },
    chipText: { color: colors.muted, fontSize: 13 },
    searchIcon: { position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 },
  }),
);
