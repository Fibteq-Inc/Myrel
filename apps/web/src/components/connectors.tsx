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
  type UpdateConnectorInput,
} from "@myrel/protocol";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ExternalLink,
  CircleAlert,
  CircleCheck,
  Globe,
  KeyRound,
  LoaderCircle,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api, connectorsQuery, platform } from "../lib/api";
import { Button, cn, errorMessage, GhostButton, IconButton, Input } from "../lib/ui";
import { Field, Notice, Section } from "./settings";
import { useConfirm } from "./ui/confirm";
import { Switch } from "./ui/controls";
import { Menu, MenuItem, MenuSeparator } from "./ui/menu";

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

/** The message for a failed connector call: the server's own message, else the first invalid field. */
function connectorError(err: unknown, t: Translate) {
  if (err instanceof ApiError && typeof err.body === "object" && err.body) {
    const body = err.body as { message?: unknown; issues?: { path?: unknown[]; message?: string }[] };
    if (typeof body.message === "string" && body.message) return body.message;
    const issue = body.issues?.[0];
    if (issue?.message) return issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    return t("connectors.invalid");
  }
  return errorMessage(err, t);
}

/** Sends the person to a server's sign-in page; it redirects back to the settings when done. */
function goToSignIn(url: string) {
  if (platform.name === "web") window.location.assign(url);
  else void platform.openExternal(url);
}

/**
 * MCP connectors: the person's own (no `projectId`) or a project's. `result` and `connectorId`
 * come back from an OAuth sign-in (`?result=ok|error&connector=<id>`).
 */
export function Connectors({
  projectId,
  canManage = true,
  result,
  connectorId,
}: {
  projectId?: string;
  canManage?: boolean;
  result?: string;
  connectorId?: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useQuery(connectorsQuery(projectId));
  const connectors = query.data ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: connectorsQuery(projectId).queryKey });

  // The add form, open and possibly prefilled by a preset.
  const [adding, setAdding] = useState<Draft | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (adding) formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [adding]);

  const catalog = canManage && <Catalog connectors={connectors} projectId={projectId} onRefresh={refresh} onSetUp={setAdding} />;

  return (
    <>
      {result && <SignInResult ok={result === "ok"} name={connectors.find((c) => c.id === connectorId)?.name} />}

      {/* Added connectors come first once there are some; until then the catalog leads. */}
      {connectors.length === 0 && catalog}

      <Section
        title={projectId ? t("connectors.projectTitle") : t("connectors.title")}
        description={projectId ? t("connectors.projectDescription") : t("connectors.description")}
      >
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <Notice tone="bad">{connectorError(query.error, t)}</Notice>
        ) : connectors.length === 0 ? (
          <div className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-[13px] text-subtle">
            {projectId ? t("connectors.projectEmpty") : t("connectors.empty")}
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-edge">
            {connectors.map((c) => (
              <ConnectorItem key={c.id} connector={c} projectId={projectId} highlight={c.id === connectorId} />
            ))}
          </ul>
        )}

        {canManage && (
          <div ref={formRef}>
            {adding ? (
              <ConnectorForm
                key={adding.key}
                initial={adding}
                projectId={projectId}
                onDone={() => {
                  setAdding(null);
                  void refresh();
                }}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <GhostButton type="button" onClick={() => setAdding(emptyDraft())} className="h-9 px-3">
                <Plus size={15} aria-hidden="true" />
                {t("connectors.add")}
              </GhostButton>
            )}
          </div>
        )}
      </Section>

      {connectors.length > 0 && catalog}
    </>
  );
}

function SignInResult({ ok, name }: { ok: boolean; name?: string }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]",
        ok ? "border-ok/40 bg-ok/5 text-body" : "border-bad/40 bg-bad/5 text-body",
      )}
    >
      {ok ? (
        <CircleCheck size={17} className="mt-px flex-none text-ok" aria-hidden="true" />
      ) : (
        <CircleAlert size={17} className="mt-px flex-none text-bad" aria-hidden="true" />
      )}
      <p className="flex-1">
        {ok
          ? name
            ? t("connectors.signedInNamed", { name })
            : t("connectors.signedIn")
          : t("connectors.signInFailed")}
      </p>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label={t("connectors.dismiss")}
        className="-m-1 rounded-md p-1 text-subtle hover:bg-hover hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// --- adding from the catalog: recommended, then the MCP Registry by category ---

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

/** A card in the catalog: a preset of Myrel's own or a server from the registry. */
type Offer =
  | { kind: "preset"; preset: ConnectorPreset }
  | { kind: "registry"; entry: CatalogConnector };

function Catalog({
  connectors,
  projectId,
  onRefresh,
  onSetUp,
}: {
  connectors: Connector[];
  projectId?: string;
  onRefresh: () => Promise<unknown>;
  onSetUp: (draft: Draft) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<CatalogCategory | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const query = useInfiniteQuery({
    queryKey: ["connector-catalog", q, category],
    queryFn: ({ pageParam }) => api.searchConnectorCatalog(q, pageParam, category ?? undefined),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  const entries = query.data?.pages.flatMap((p) => p.connectors) ?? [];
  const syncedAt = query.data?.pages[0]?.syncedAt;
  const counts = new Map(query.data?.pages[0]?.categories.map((c) => [c.id, c.count]));

  // Myrel's own presets: the featured ones are recommended above everything; the others join the
  // registry's servers in their category (they are not in the registry).
  const matches = (p: ConnectorPreset) =>
    !q || `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase());
  const recommended = !category ? CONNECTOR_PRESETS.filter((p) => p.featured && matches(p)) : [];
  const extras = CONNECTOR_PRESETS.filter((p) => !p.featured && (!category || p.category === category) && matches(p));
  const offers: Offer[] = [
    ...entries.filter((e) => e.popular).map((entry): Offer => ({ kind: "registry", entry })),
    ...extras.map((preset): Offer => ({ kind: "preset", preset })),
    ...entries.filter((e) => !e.popular).map((entry): Offer => ({ kind: "registry", entry })),
  ];

  const connect = useMutation({
    mutationFn: (o: { key: string; name: string; url: string }) =>
      api.createConnector({ transport: "http", name: o.name.slice(0, 60), url: o.url, auth: "oauth" }, projectId),
    onSuccess: async (res) => {
      if (res.authorizeUrl) return goToSignIn(res.authorizeUrl);
      await onRefresh();
    },
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
      <div
        key={key}
        className={cn(
          "flex flex-col gap-3 rounded-xl border p-3.5",
          p?.featured ? "border-accent/40 bg-accent-soft/40" : "border-edge bg-panel",
        )}
      >
        <div className="flex items-start gap-3">
          <OfferIcon name={name} featured={p?.featured} terminal={p?.transport === "stdio"} iconUrl={e?.popular ? e.iconUrl : null} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium" title={e?.id}>
                {name}
              </span>
              {p?.featured && (
                <span className="inline-flex flex-none items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
                  <Sparkles size={11} aria-hidden="true" />
                  {t("connectors.featured")}
                </span>
              )}
              {e?.popular && (
                <span className="flex-none rounded-md bg-hover px-1.5 py-0.5 text-[11px] font-medium text-muted">
                  {t("connectors.catalogPopular")}
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-subtle">{description}</p>
          </div>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-subtle">
            {p?.transport === "stdio" ? (
              <span>{t("connectors.type.stdio")}</span>
            ) : (
              !signsIn && (
                <span className="inline-flex items-center gap-1">
                  <KeyRound size={11} aria-hidden="true" />
                  {t("connectors.catalogNeedsKey")}
                </span>
              )
            )}
            {e?.websiteUrl && (
              <a href={e.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 truncate hover:text-fg">
                <ExternalLink size={11} aria-hidden="true" />
                {t("connectors.catalogWebsite")}
              </a>
            )}
          </span>
          {added ? (
            <span className="inline-flex h-8 items-center gap-1.5 px-1 text-[13px] text-ok">
              <Check size={14} aria-hidden="true" />
              {t("connectors.added")}
            </span>
          ) : signsIn && url ? (
            <GhostButton type="button" disabled={connect.isPending} onClick={() => connect.mutate({ key, name, url })}>
              {busy ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />}
              {t("connectors.connect")}
            </GhostButton>
          ) : (
            <GhostButton type="button" onClick={() => onSetUp(p ? draftFromPreset(p) : draftFromCatalog(e!))}>
              <Plus size={14} aria-hidden="true" />
              {t("connectors.setUp")}
            </GhostButton>
          )}
        </div>
      </div>
    );
  };

  const grid = "grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3";
  return (
    <Section title={t("connectors.catalog")} description={t("connectors.catalogDescription")}>
      <div className="relative">
        <Search size={15} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
        <Input
          type="search"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder={t("connectors.catalogSearch")}
          aria-label={t("connectors.catalogSearch")}
          className="pl-9"
        />
      </div>
      <div role="group" aria-label={t("connectors.categories")} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        <CategoryChip active={!category} onClick={() => setCategory(null)} label={t("connectors.category.all")} />
        {CATALOG_CATEGORIES.map((c) => (
          <CategoryChip key={c} active={category === c} onClick={() => setCategory(c)} label={t(CATEGORY_LABELS[c])} count={counts.get(c)} />
        ))}
      </div>

      {recommended.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted">{t("connectors.recommended")}</h3>
          <div className={grid}>{recommended.map((preset) => card({ kind: "preset", preset }))}</div>
        </div>
      )}

      <div className="space-y-2">
        {recommended.length > 0 && <h3 className="text-xs font-medium text-muted">{t("connectors.catalogAll")}</h3>}
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <Notice tone="bad">{connectorError(query.error, t)}</Notice>
        ) : offers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-[13px] text-subtle">
            {!syncedAt && !q && !category ? t("connectors.catalogFilling") : t("connectors.catalogEmpty", { q })}
          </div>
        ) : (
          <div className={cn(grid, query.isPlaceholderData && "opacity-60")}>{offers.map(card)}</div>
        )}
      </div>
      {connect.error && <Notice tone="bad">{connectorError(connect.error, t)}</Notice>}
      {query.hasNextPage && (
        <GhostButton type="button" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} className="h-9 px-3">
          {query.isFetchingNextPage && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          {t("connectors.catalogMore")}
        </GhostButton>
      )}
    </Section>
  );
}

function CategoryChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 flex-none items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap transition-colors",
        active ? "border-fg bg-fg text-ground" : "border-edge text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {label}
      {count !== undefined && <span className={cn("text-[11px] tabular-nums", active ? "text-ground/70" : "text-subtle")}>{count.toLocaleString()}</span>}
    </button>
  );
}

/**
 * Only Myrel's presets and the well-known services show an icon of their own: the rest come from
 * anyone who publishes to the registry, and loading their images would tell those hosts who opened
 * the settings.
 */
export function OfferIcon({ name, featured, terminal, iconUrl }: { name: string; featured?: boolean; terminal?: boolean; iconUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 flex-none items-center justify-center overflow-hidden rounded-lg text-sm font-semibold",
        featured ? "bg-accent text-ground" : "bg-hover text-muted",
      )}
    >
      {terminal ? (
        <SquareTerminal size={17} />
      ) : iconUrl && !failed ? (
        <img src={iconUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-6 object-contain" onError={() => setFailed(true)} />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

// --- the list ---

function ConnectorItem({ connector: c, projectId, highlight }: { connector: Connector; projectId?: string; highlight?: boolean }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const key = connectorsQuery(projectId).queryKey;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const replace = (next: Connector) =>
    queryClient.setQueryData<Connector[]>(key, (list) => list?.map((x) => (x.id === next.id ? next : x)));

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateConnector(c.id, { enabled }, projectId),
    onSuccess: replace,
  });
  const check = useMutation({ mutationFn: () => api.checkConnector(c.id, projectId), onSuccess: replace });
  const signIn = useMutation({ mutationFn: () => api.authorizeConnector(c.id, projectId), onSuccess: goToSignIn });
  const remove = useMutation({
    mutationFn: () => api.deleteConnector(c.id, projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const error = toggle.error ?? check.error ?? signIn.error ?? remove.error;

  const details = c.transport === "http" ? c.url : [c.command, ...c.args].join(" ");
  const refreshTools = c.transport === "http" && c.enabled && c.status !== "needs_auth" && (
    <button
      type="button"
      disabled={check.isPending}
      onClick={() => check.mutate()}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-60"
    >
      <RefreshCw size={12} className={cn(check.isPending && "animate-spin")} aria-hidden="true" />
      {t("connectors.refreshTools")}
    </button>
  );

  return (
    <li className={cn("bg-panel", highlight && "bg-accent-soft/30")}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span
          aria-hidden="true"
          className="flex size-9 flex-none items-center justify-center rounded-lg bg-hover text-muted"
        >
          {c.transport === "http" ? <Globe size={17} /> : <SquareTerminal size={17} />}
        </span>
        <div className={cn("min-w-0 flex-1", !c.enabled && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-medium">{c.name}</span>
            <code className="rounded bg-hover px-1 py-px font-mono text-[11px] text-subtle">{c.slug}</code>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle">
            <span>{c.transport === "http" ? t("connectors.type.http") : t("connectors.type.stdio")}</span>
            <span aria-hidden="true">·</span>
            <StatusBadge connector={c} />
          </div>
        </div>

        <div className="flex flex-none items-center gap-1">
          {c.enabled && c.status === "needs_auth" && c.canEdit && (
            <GhostButton type="button" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
              {signIn.isPending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />}
              {t("connectors.signIn")}
            </GhostButton>
          )}
          {c.enabled && c.transport === "http" && (c.status === "error" || c.status === "unknown") && (
            <GhostButton type="button" disabled={check.isPending} onClick={() => check.mutate()}>
              <RefreshCw size={14} className={cn(check.isPending && "animate-spin")} aria-hidden="true" />
              {t("connectors.retry")}
            </GhostButton>
          )}
          {c.canEdit && (
            <Switch
              className="mx-1.5"
              checked={c.enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
              aria-label={t("connectors.enabledLabel", { name: c.name })}
              title={c.enabled ? t("connectors.on") : t("connectors.off")}
            />
          )}
          <IconButton
            type="button"
            className="size-8"
            aria-expanded={open}
            aria-label={open ? t("connectors.hideDetails") : t("connectors.showDetails")}
            title={open ? t("connectors.hideDetails") : t("connectors.showDetails")}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown size={16} className={cn("transition-transform", open && "rotate-180")} />
          </IconButton>
          {c.canEdit && (
            <Menu
              label={t("connectors.actions", { name: c.name })}
              align="end"
              panelClassName="min-w-44"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
              trigger={<MoreHorizontal size={16} />}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Pencil size={14} />}
                    onSelect={() => {
                      close();
                      setEditing(true);
                      setOpen(false);
                    }}
                  >
                    {t("connectors.edit")}
                  </MenuItem>
                  {c.transport === "http" && (
                    <MenuItem
                      icon={<RefreshCw size={14} />}
                      onSelect={() => {
                        close();
                        check.mutate();
                      }}
                    >
                      {t("connectors.refreshTools")}
                    </MenuItem>
                  )}
                  {c.auth === "oauth" && (
                    <MenuItem
                      icon={<LogIn size={14} />}
                      onSelect={() => {
                        close();
                        signIn.mutate();
                      }}
                    >
                      {t("connectors.signInAgain")}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    className="text-bad hover:text-bad"
                    onSelect={async () => {
                      close();
                      const ok = await confirm({
                        title: t("connectors.deleteConfirm", { name: c.name }),
                        body: projectId ? t("connectors.deleteBodyProject") : t("connectors.deleteBody"),
                        action: t("connectors.delete"),
                        danger: true,
                      });
                      if (ok) remove.mutate();
                    }}
                  >
                    {t("connectors.delete")}
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
      </div>

      {c.status === "error" && c.lastError && c.enabled && (
        <p className="-mt-1 px-3.5 pb-3 pl-[62px] text-xs text-bad">{c.lastError}</p>
      )}
      {error && <p className="-mt-1 px-3.5 pb-3 pl-[62px] text-xs text-bad">{connectorError(error, t)}</p>}

      {open && !editing && (
        <div className="space-y-3 border-t border-line px-3.5 py-3 sm:pl-[62px]">
          {details && (
            <div className="truncate font-mono text-xs text-subtle" title={details}>
              {details}
            </div>
          )}
          {c.secretNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              <ShieldCheck size={13} aria-hidden="true" />
              {c.transport === "http" ? t("connectors.storedHeaders") : t("connectors.storedEnv")}
              {c.secretNames.map((n) => (
                <code key={n} className="rounded bg-hover px-1 py-px font-mono text-[11px]">
                  {n}
                </code>
              ))}
            </div>
          )}
          {c.tools.length > 0 ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted">{t("connectors.tools")}</span>
                {refreshTools}
              </div>
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {c.tools.map((tool) => (
                  <li key={tool.name} className="flex gap-2 text-xs">
                    <Wrench size={12} className="mt-0.5 flex-none text-subtle" aria-hidden="true" />
                    <span className="min-w-0">
                      <code className="font-mono text-body">{tool.name}</code>
                      {tool.description && <span className="ml-1.5 text-subtle">{firstLine(tool.description)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-subtle">
                {c.transport === "stdio" ? t("connectors.toolsUnknown") : t("connectors.noTools")}
              </p>
              {refreshTools}
            </div>
          )}
        </div>
      )}

      {editing && (
        <div className="border-t border-line p-3.5">
          <ConnectorForm
            initial={draftFromConnector(c)}
            existing={c}
            projectId={projectId}
            onDone={(next) => {
              if (next) replace(next);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </li>
  );
}

function firstLine(text: string) {
  const line = text.split("\n")[0]!.trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function StatusBadge({ connector: c }: { connector: Connector }) {
  const t = useT();
  if (!c.enabled) return <span className="text-subtle">{t("connectors.off")}</span>;
  switch (c.status) {
    case "ok":
      return (
        <span className="inline-flex items-center gap-1.5 text-ok">
          <Dot className="bg-ok" />
          {c.tools.length > 0
            ? t("connectors.status.okTools", { count: c.tools.length })
            : t("connectors.status.ok")}
        </span>
      );
    case "needs_auth":
      return (
        <span className="inline-flex items-center gap-1.5 text-warn">
          <Dot className="bg-warn" />
          {t("connectors.status.needsAuth")}
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 text-bad">
          <Dot className="bg-bad" />
          {t("connectors.status.error")}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5">
          <Dot className="bg-subtle" />
          {c.transport === "stdio" ? t("connectors.status.startsWithAgent") : t("connectors.status.unknown")}
        </span>
      );
  }
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden="true" className={cn("size-1.5 flex-none rounded-full", className)} />;
}

// --- add and edit ---

type Pair = { id: number; key: string; value: string; placeholder?: string; stored?: boolean };

type Draft = {
  /** Remounts the form when a preset fills it again. */
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

function emptyDraft(): Draft {
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

function draftFromConnector(c: Connector): Draft {
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

const toMap = (pairs: Pair[]) =>
  Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

function ConnectorForm({
  initial,
  existing,
  projectId,
  onDone,
  onCancel,
}: {
  initial: Draft;
  /** Set when editing; the type and sign-in method stay as they are. */
  existing?: Connector;
  projectId?: string;
  onDone: (connector?: Connector) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [d, setD] = useState(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const editing = !!existing;
  const oauth = d.transport === "http" && d.auth === "oauth";
  const args = d.args.split("\n").map((a) => a.trim()).filter(Boolean);

  const save = useMutation({
    mutationFn: async (): Promise<Connector | undefined> => {
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
        return api.updateConnector(existing.id, input, projectId);
      }
      const input: CreateConnectorInput =
        d.transport === "http"
          ? { transport: "http", name: d.name.trim(), url: d.url.trim(), auth: d.auth, headers: oauth ? {} : toMap(d.headers) }
          : { transport: "stdio", name: d.name.trim(), command: d.command.trim(), args, env: toMap(d.env), runsOn: d.runsOn };
      const res = await api.createConnector(input, projectId);
      if (res.authorizeUrl) goToSignIn(res.authorizeUrl);
      return res.connector;
    },
    onSuccess: (c) => onDone(c),
  });

  const valid = d.name.trim() && (d.transport === "http" ? /^https:\/\/\S+$/.test(d.url.trim()) : d.command.trim());

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (valid) save.mutate();
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn("space-y-4", !editing && "rounded-xl border border-edge bg-panel p-4")}
    >
      {!editing && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold">{t("connectors.addTitle")}</h3>
            <p className="mt-0.5 text-xs text-subtle">{t("connectors.addHelp")}</p>
          </div>
          <IconButton type="button" className="-m-1.5 size-8" onClick={onCancel} aria-label={t("common.cancel")} title={t("common.cancel")}>
            <X size={15} />
          </IconButton>
        </div>
      )}

      <Field label={t("connectors.name")}>
        <Input
          value={d.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder={t("connectors.namePlaceholder")}
          maxLength={60}
          required
          autoFocus={!editing}
        />
      </Field>

      {!editing && (
        <FieldGroup label={t("connectors.type")}>
          <Segmented
            label={t("connectors.type")}
            value={d.transport}
            onChange={(v) => set("transport", v)}
            options={[
              { value: "http", label: t("connectors.type.http"), icon: <Globe size={14} /> },
              { value: "stdio", label: t("connectors.type.stdio"), icon: <SquareTerminal size={14} /> },
            ]}
          />
        </FieldGroup>
      )}

      {d.transport === "http" ? (
        <>
          <Field label={t("connectors.url")}>
            <Input
              type="url"
              value={d.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              required
            />
          </Field>
          {!editing && (
            <FieldGroup label={t("connectors.auth")}>
              <Segmented
                label={t("connectors.auth")}
                value={d.auth}
                onChange={(v) => set("auth", v)}
                options={[
                  { value: "oauth", label: t("connectors.auth.oauth") },
                  { value: "headers", label: t("connectors.auth.headers") },
                ]}
              />
              <p className="text-xs text-subtle">
                {d.auth === "oauth" ? t("connectors.auth.oauthHint") : t("connectors.auth.headersHint")}
              </p>
            </FieldGroup>
          )}
          {!oauth && (
            <PairsEditor
              label={t("connectors.headers")}
              addLabel={t("connectors.addHeader")}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              pairs={d.headers}
              onChange={(v) => set("headers", v)}
            />
          )}
        </>
      ) : (
        <>
          <Field label={t("connectors.command")}>
            <Input
              value={d.command}
              onChange={(e) => set("command", e.target.value)}
              placeholder="npx"
              spellCheck={false}
              className="font-mono"
              required
            />
          </Field>
          <Field label={t("connectors.args")} hint={t("connectors.argsHint")}>
            <textarea
              value={d.args}
              onChange={(e) => set("args", e.target.value)}
              rows={Math.min(6, Math.max(3, d.args.split("\n").length))}
              spellCheck={false}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
              className="w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-[13px] text-fg outline-none placeholder:text-subtle focus:border-accent"
            />
          </Field>
          <PairsEditor
            label={t("connectors.env")}
            addLabel={t("connectors.addEnv")}
            keyPlaceholder="API_KEY"
            valuePlaceholder={t("connectors.valuePlaceholder")}
            pairs={d.env}
            onChange={(v) => set("env", v)}
          />
          <FieldGroup label={t("connectors.runsOn")}>
            <Segmented
              label={t("connectors.runsOn")}
              value={d.runsOn}
              onChange={(v) => set("runsOn", v)}
              options={RUNS_ON.map((r) => ({ value: r.value, label: t(r.label) }))}
            />
          </FieldGroup>
        </>
      )}

      {editing && existing.auth === "oauth" && <p className="text-xs text-subtle">{t("connectors.oauthEditHint")}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={save.isPending || !valid}>
          {save.isPending && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          {editing ? t("settings.saveChanges") : oauth ? t("connectors.addAndSignIn") : t("connectors.addButton")}
        </Button>
        <GhostButton type="button" onClick={onCancel} className="h-9 px-3">
          {t("common.cancel")}
        </GhostButton>
      </div>
      {save.error && <Notice tone="bad">{connectorError(save.error, t)}</Notice>}
    </form>
  );
}

/** A label above a control that is not a single input (so not a <label>). */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[13px] font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

/** A row of buttons picking one value, in place of a select for two or three choices. */
function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string; icon?: ReactNode }[];
  onChange: (value: V) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg border border-edge bg-raised p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px]",
              on ? "bg-hover text-fg shadow-[inset_0_0_0_1px_var(--color-edge)]" : "text-muted hover:text-fg",
            )}
          >
            {o.icon && <span aria-hidden="true">{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Name/value rows for headers or environment variables; values are masked. */
function PairsEditor({
  label,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  pairs,
  onChange,
}: {
  label: string;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
}) {
  const t = useT();
  const id = useId();
  const update = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-1.5" role="group" aria-labelledby={id}>
      <span id={id} className="block text-[13px] font-medium text-muted">
        {label}
      </span>
      {pairs.map((p, i) => (
        <div key={p.id} className="flex items-center gap-2">
          <Input
            value={p.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            aria-label={t("connectors.pairName")}
            spellCheck={false}
            className="w-2/5 font-mono text-[13px]"
          />
          <Input
            type="password"
            autoComplete="off"
            value={p.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={p.stored ? t("connectors.storedValue") : (p.placeholder ?? valuePlaceholder)}
            aria-label={t("connectors.pairValue", { name: p.key || keyPlaceholder })}
            spellCheck={false}
            className="flex-1 font-mono text-[13px]"
          />
          <IconButton
            type="button"
            className="size-8"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            aria-label={t("connectors.removePair", { name: p.key || keyPlaceholder })}
            title={t("connectors.removePairTitle")}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, pair()])}
        className="inline-flex items-center gap-1.5 rounded-md py-1 text-[13px] text-accent hover:underline"
      >
        <Plus size={13} aria-hidden="true" />
        {addLabel}
      </button>
    </div>
  );
}

function Loading() {
  const t = useT();
  return (
    <div className="flex justify-center py-6 text-subtle">
      <LoaderCircle size={18} className="animate-spin" aria-label={t("common.loading")} />
    </div>
  );
}
