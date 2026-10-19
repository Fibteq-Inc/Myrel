import type { Artifact, ArtifactRef, Thread } from "@altair/protocol";
import { useT } from "@altair/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  ArrowLeft,
  Blocks,
  Check,
  ChevronRight,
  Code,
  Download,
  ExternalLink,
  Eye,
  Link as LinkIcon,
  LoaderCircle,
  RotateCw,
  Search,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { api } from "../lib/api";
import { cn, IconButton, useRelativeTime } from "../lib/ui";

/**
 * Artifacts in the UI: cards under the messages that delivered them, the viewer
 * (a sandboxed iframe on the artifact origin) and artifact lists. Routes decide
 * where these sit; nothing here assumes a layout.
 */

/** Same flags as the CSP `sandbox` the artifact Worker sends: scripts run, but on an opaque origin. */
const IFRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export const artifactQuery = (projectId: string, artifactId: string) => ({
  queryKey: ["projects", projectId, "artifacts", artifactId],
  queryFn: () => api.getArtifact(projectId, artifactId),
});

/** The stable, shareable in-app address of an artifact (always opens the latest version). */
export function artifactAppUrl(projectId: string, artifactId: string) {
  return `${location.origin}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

// ---- Cards -----------------------------------------------------------------

/**
 * Cards for the artifacts a message delivered. Inside a thread they open the
 * artifact in the thread's workspace; elsewhere, on the artifact's own page.
 */
export function ArtifactCards({
  projectId,
  threadId,
  refs,
  artifacts,
  openId,
}: {
  projectId: string;
  threadId?: string;
  refs?: ArtifactRef[];
  /** Current artifacts by id, to show when a newer version exists. */
  artifacts: Record<string, Artifact>;
  openId?: string;
}) {
  const t = useT();
  const cards = refs ?? [];
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {cards.map((a) => {
        const current = artifacts[a.artifactId];
        const latest = current?.version ?? a.version;
        const version = a.version < latest ? a.version : undefined;
        const className = cn(
          "group flex max-w-md items-center gap-3 rounded-xl border bg-raised px-3 py-2.5 text-fg hover:border-edge hover:bg-hover",
          openId === a.artifactId ? "border-accent/60" : "border-[#26262b]",
        );
        const body = (
          <>
            <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-edge bg-panel text-accent">
              <AppWindow size={17} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold">{current?.title ?? a.title}</span>
              <span className="block truncate text-xs text-subtle">
                {version ? t("artifacts.olderVersion", { version: a.version, latest }) : t("artifacts.cardVersion", { version: a.version })}
              </span>
            </span>
            <ChevronRight size={15} className="flex-none text-subtle group-hover:text-muted" aria-hidden="true" />
          </>
        );
        return threadId ? (
          <Link
            key={`${a.artifactId}-${a.version}`}
            to="/projects/$projectId/threads/$threadId"
            params={{ projectId, threadId }}
            search={{ artifact: a.artifactId, version }}
            className={className}
          >
            {body}
          </Link>
        ) : (
          <Link
            key={`${a.artifactId}-${a.version}`}
            to="/projects/$projectId/artifacts/$artifactId"
            params={{ projectId, artifactId: a.artifactId }}
            search={{ version }}
            className={className}
          >
            {body}
          </Link>
        );
      })}
    </div>
  );
}

// ---- Viewer ----------------------------------------------------------------

/**
 * One artifact: toolbar (version, preview/code, reload, copy link, download,
 * open in a new tab) over the sandboxed preview. `leading` sits before the
 * title, e.g. a back button; the caller owns where the version is stored.
 */
export function ArtifactViewer({
  projectId,
  artifactId,
  version: pinned,
  onVersionChange,
  leading,
  className = "",
}: {
  projectId: string;
  artifactId: string;
  /** A specific version to show; latest when omitted. */
  version?: number;
  /** Called with undefined for the latest version. */
  onVersionChange: (version: number | undefined) => void;
  leading?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [reloads, setReloads] = useState(0);
  const detail = useQuery(artifactQuery(projectId, artifactId));
  const artifact = detail.data?.artifact;
  const versions = detail.data?.versions ?? [];
  const version = pinned ?? artifact?.version;

  const view = useQuery({
    queryKey: ["projects", projectId, "artifacts", artifactId, "view", version],
    queryFn: () => api.artifactView(projectId, artifactId, version),
    enabled: version !== undefined,
    // Signed links last an hour; fetch a fresh one well before that.
    staleTime: 30 * 60_000,
    refetchInterval: 45 * 60_000,
  });
  const source = useQuery({
    queryKey: ["projects", projectId, "artifacts", artifactId, "source", version],
    queryFn: () => api.artifactSource(projectId, artifactId, version!),
    enabled: version !== undefined && tab === "code",
    staleTime: Infinity,
  });

  async function download() {
    if (version === undefined || !artifact) return;
    const html = source.data ?? (await api.artifactSource(projectId, artifactId, version));
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${slug(artifact.title)}.html` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section
      aria-label={artifact ? t("artifacts.labelNamed", { title: artifact.title }) : t("artifacts.artifact")}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}
    >
      <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line px-3">
        {leading}
        <AppWindow size={16} className="flex-none text-accent" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{artifact?.title ?? t("artifacts.artifact")}</h2>
        {versions.length > 1 && (
          <select
            aria-label={t("artifacts.version")}
            value={version}
            onChange={(e) => {
              const v = Number(e.target.value);
              onVersionChange(v === artifact?.version ? undefined : v);
            }}
            className="h-7 flex-none rounded-md border border-edge bg-raised px-1.5 text-xs text-muted outline-none hover:text-fg"
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
                {v.version === artifact?.version ? ` ${t("artifacts.latest")}` : ""}
              </option>
            ))}
          </select>
        )}
        <div className="flex flex-none items-center gap-0.5">
          <Tabs value={tab} onChange={setTab} />
          <IconButton
            type="button"
            aria-label={t("artifacts.reload")}
            title={t("artifacts.reload")}
            onClick={() => setReloads((n) => n + 1)}
            className="max-sm:hidden"
          >
            <RotateCw size={15} />
          </IconButton>
          <CopyLink url={artifactAppUrl(projectId, artifactId)} />
          <IconButton type="button" aria-label={t("artifacts.download")} title={t("artifacts.download")} onClick={download} className="max-sm:hidden">
            <Download size={15} />
          </IconButton>
          {view.data?.url && (
            <a
              href={view.data.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("artifacts.openTab")}
              title={t("artifacts.openTab")}
              className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
            >
              <ExternalLink size={15} />
            </a>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {detail.isError ? (
          <Empty title={t("artifacts.notFound")} body={t("artifacts.notFoundBody")} />
        ) : tab === "code" ? (
          source.data !== undefined ? (
            <pre className="absolute inset-0 overflow-auto bg-rail p-4 font-mono text-xs leading-relaxed text-body">
              <code>{source.data}</code>
            </pre>
          ) : (
            <Loading />
          )
        ) : view.data && !view.data.url ? (
          <Empty
            title={t("artifacts.noPreviews")}
            body={t("artifacts.noPreviewsBody")}
          />
        ) : view.data?.url ? (
          <iframe
            key={`${view.data.url}-${reloads}`}
            src={view.data.url}
            title={artifact?.title ?? t("artifacts.artifact")}
            sandbox={IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full border-0 bg-white"
          />
        ) : (
          <Loading />
        )}
      </div>
    </section>
  );
}

function Tabs({ value, onChange }: { value: "preview" | "code"; onChange: (v: "preview" | "code") => void }) {
  const t = useT();
  const item = (v: "preview" | "code", label: string, icon: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={value === v}
      onClick={() => onChange(v)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs",
        value === v ? "bg-hover text-fg" : "text-subtle hover:text-fg",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
  return (
    <div role="tablist" aria-label={t("artifacts.view")} className="mr-1 flex rounded-lg border border-edge bg-raised p-0.5">
      {item("preview", t("artifacts.preview"), <Eye size={13} aria-hidden="true" />)}
      {item("code", t("artifacts.code"), <Code size={13} aria-hidden="true" />)}
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    // The in-app address is stable and opens the latest version; signed links expire.
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <IconButton type="button" aria-label={copied ? t("common.copied") : t("artifacts.copyLink")} title={t("artifacts.copyLink")} onClick={copy} className="max-sm:hidden">
      {copied ? <Check size={15} className="text-ok" /> : <LinkIcon size={15} />}
    </IconButton>
  );
}

/** A back arrow for the viewer's `leading` slot. */
export function ViewerBack({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <IconButton type="button" aria-label={label} title={label} onClick={onClick} className="-ml-1 flex-none">
      <ArrowLeft size={16} />
    </IconButton>
  );
}

// ---- Lists -----------------------------------------------------------------

export type ArtifactListItem = Artifact & {
  /** Where it came from, shown under the title (e.g. the thread or project name). */
  origin?: string;
};

/**
 * A searchable list of artifacts. Each row links to the artifact's page, or
 * calls `onSelect` when given (e.g. to open it inside a thread's workspace).
 */
export function ArtifactList({
  items,
  onSelect,
  empty,
}: {
  items: ArtifactListItem[];
  onSelect?: (artifact: Artifact) => void;
  empty: ReactNode;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter((a) => `${a.title} ${a.description ?? ""} ${a.origin ?? ""}`.toLocaleLowerCase().includes(q));
  }, [items, query]);

  if (items.length === 0) return <>{empty}</>;

  const row = (a: ArtifactListItem) => (
    <>
      <span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg border border-edge bg-panel text-accent">
        <AppWindow size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg">{a.title}</span>
        {a.description && <span className="block truncate text-[13px] text-muted">{a.description}</span>}
        <span className="mt-0.5 block truncate text-xs text-subtle">
          v{a.version} · {relativeTime(a.updatedAt)}
          {a.origin && ` · ${a.origin}`}
        </span>
      </span>
    </>
  );
  const rowClass = "flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-hover";

  return (
    <div className="flex flex-col gap-2">
      {items.length > 5 && (
        <label className="mx-1 flex h-9 items-center gap-2 rounded-lg border border-edge bg-raised px-3 focus-within:border-accent">
          <Search size={14} className="text-subtle" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("artifacts.search")}
            aria-label={t("artifacts.search")}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
          />
        </label>
      )}
      {shown.length === 0 ? (
        <p className="px-3 py-6 text-center text-[13px] text-subtle">{t("artifacts.noMatch", { query })}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {shown.map((a) => (
            <li key={a.id}>
              {onSelect ? (
                <button type="button" onClick={() => onSelect(a)} className={rowClass}>
                  {row(a)}
                </button>
              ) : (
                <Link
                  to="/projects/$projectId/artifacts/$artifactId"
                  params={{ projectId: a.projectId, artifactId: a.id }}
                  search={{}}
                  className={rowClass}
                >
                  {row(a)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The thread's Outputs tab: what it published, opened in place. */
export function ThreadOutputs({
  projectId,
  thread,
  artifacts,
  openId,
  version,
  onOpen,
}: {
  projectId: string;
  thread: Thread;
  /** This thread's artifacts, newest first. */
  artifacts: Artifact[];
  openId?: string;
  version?: number;
  /** Open an artifact (undefined = back to the list), at a version (undefined = latest). */
  onOpen: (artifactId: string | undefined, version?: number) => void;
}) {
  const t = useT();
  if (openId) {
    return (
      <ArtifactViewer
        key={openId}
        projectId={projectId}
        artifactId={openId}
        version={version}
        onVersionChange={(v) => onOpen(openId, v)}
        leading={<ViewerBack label={t("artifacts.allOutputs")} onClick={() => onOpen(undefined)} />}
        className="h-full"
      />
    );
  }
  return (
    <div className="p-2">
      <ArtifactList
        items={artifacts}
        onSelect={(a) => onOpen(a.id)}
        empty={
          <Empty
            icon={<Blocks size={20} className="text-subtle" aria-hidden="true" />}
            title={t("workspace.outputsEmpty")}
            body={t("artifacts.threadEmpty", { title: thread.title })}
          />
        }
      />
    </div>
  );
}

// ---- Helpers ---------------------------------------------------------------

function Loading() {
  const t = useT();
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-subtle" role="status">
      <LoaderCircle size={18} className="animate-spin" aria-label={t("common.loading")} />
    </div>
  );
}

export function Empty({ icon, title, body }: { icon?: ReactNode; title: string; body: string }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && (
        <span className="mb-1 flex size-11 items-center justify-center rounded-xl border border-line bg-raised">{icon}</span>
      )}
      <p className="font-medium text-body">{title}</p>
      <p className="max-w-sm text-[13px] text-subtle">{body}</p>
    </div>
  );
}

function slug(title: string) {
  return title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "artifact";
}
