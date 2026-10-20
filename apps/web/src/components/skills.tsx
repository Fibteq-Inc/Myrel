import { ApiError } from "@myrel/client";
import type { Translate } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { CreateSkillInput, Skill, SkillChoices, SkillFileUpload } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookMarked,
  ChevronDown,
  ExternalLink,
  FileText,
  FolderUp,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { api, platform, skillsQuery } from "../lib/api";
import { Button, cn, errorMessage, GhostButton, IconButton, Input } from "../lib/ui";
import { Field, Notice, Section } from "./settings";
import { useConfirm } from "./ui/confirm";
import { Switch } from "./ui/controls";
import { Menu, MenuItem, MenuSeparator } from "./ui/menu";

/** Where people find skills to add. */
const SKILLS_DIRECTORY = "https://skills.sh";

/** The message for a failed skill call: the server's own message, else the first invalid field. */
function skillError(err: unknown, t: Translate) {
  if (err instanceof ApiError && typeof err.body === "object" && err.body) {
    const body = err.body as { message?: unknown; issues?: { path?: unknown[]; message?: string }[] };
    if (typeof body.message === "string" && body.message) return body.message;
    const issue = body.issues?.[0];
    if (issue?.message) return issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    return t("skills.invalid");
  }
  return errorMessage(err, t);
}

function openLink(url: string) {
  if (platform.name === "web") window.open(url, "_blank", "noopener");
  else void platform.openExternal(url);
}

function githubUrl(skill: Skill): string | null {
  if (skill.source.kind !== "github") return null;
  const { repo, commit, path } = skill.source;
  return `https://github.com/${repo}/tree/${commit}${path ? `/${path}` : ""}`;
}

type Adding = "github" | "write" | null;

/** Agent Skills: the person's own (no `projectId`) or a project's. */
export function Skills({ projectId, canManage = true }: { projectId?: string; canManage?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useQuery(skillsQuery(projectId));
  const skills = query.data ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: skillsQuery(projectId).queryKey });
  const [adding, setAdding] = useState<Adding>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (files: FileList) => api.createSkill({ kind: "upload", files: await readFolder(files) }, projectId),
    onSuccess: () => refresh(),
  });

  return (
    <Section
      title={projectId ? t("skills.projectTitle") : t("skills.title")}
      description={
        <>
          {projectId ? t("skills.projectDescription") : t("skills.description")}{" "}
          <button type="button" onClick={() => openLink(SKILLS_DIRECTORY)} className="text-accent hover:underline">
            {t("skills.browse")}
          </button>
        </>
      }
    >
      {query.isPending ? (
        <div className="flex items-center gap-2 py-4 text-[13px] text-subtle">
          <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
          {t("skills.loading")}
        </div>
      ) : query.error ? (
        <Notice tone="bad">{skillError(query.error, t)}</Notice>
      ) : skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-[13px] text-subtle">
          {projectId ? t("skills.projectEmpty") : t("skills.empty")}
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-edge">
          {skills.map((s) => (
            <SkillItem key={s.id} skill={s} projectId={projectId} />
          ))}
        </ul>
      )}

      {canManage &&
        (adding === "github" ? (
          <GithubForm projectId={projectId} onDone={() => (setAdding(null), void refresh())} onCancel={() => setAdding(null)} />
        ) : adding === "write" ? (
          <WriteForm projectId={projectId} onDone={() => (setAdding(null), void refresh())} onCancel={() => setAdding(null)} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <GhostButton type="button" onClick={() => setAdding("github")} className="h-9 px-3">
              <GitBranch size={15} aria-hidden="true" />
              {t("skills.addGithub")}
            </GhostButton>
            <GhostButton type="button" onClick={() => setAdding("write")} className="h-9 px-3">
              <Pencil size={15} aria-hidden="true" />
              {t("skills.addWrite")}
            </GhostButton>
            <GhostButton type="button" disabled={upload.isPending} onClick={() => folderInput.current?.click()} className="h-9 px-3">
              {upload.isPending ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <FolderUp size={15} aria-hidden="true" />}
              {t("skills.addFolder")}
            </GhostButton>
            <input
              ref={(el) => {
                folderInput.current = el;
                // Not in React's types: lets the picker choose a whole folder.
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) upload.mutate(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        ))}
      {upload.error && <Notice tone="bad">{skillError(upload.error, t)}</Notice>}
    </Section>
  );
}

/** A picked folder's files, relative to the folder, base64-encoded. Hidden files and folders are left out. */
async function readFolder(list: FileList): Promise<SkillFileUpload[]> {
  const files = [...list].map((f) => ({ file: f, path: (f.webkitRelativePath || f.name).split("/") }));
  // The picked folder itself is the first part of every path.
  const strip = files.every((f) => f.path.length > 1 && f.path[0] === files[0]!.path[0]) ? 1 : 0;
  const out: SkillFileUpload[] = [];
  for (const { file, path } of files) {
    const parts = path.slice(strip);
    if (parts.some((p) => p.startsWith(".")) || parts.includes("node_modules")) continue;
    out.push({ path: parts.join("/"), content: await toBase64(file) });
  }
  return out;
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// --- the list ---

function SkillItem({ skill: s, projectId }: { skill: Skill; projectId?: string }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const key = skillsQuery(projectId).queryKey;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const replace = (next: Skill) => queryClient.setQueryData<Skill[]>(key, (list) => list?.map((x) => (x.id === next.id ? next : x)));

  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.updateSkill(s.id, { enabled }, projectId), onSuccess: replace });
  const update = useMutation({
    mutationFn: () => api.updateSkillFromSource(s.id, projectId),
    onSuccess: (res) => {
      replace(res.skill);
      setNotice(res.changed ? t("skills.updated") : t("skills.upToDate"));
      void queryClient.invalidateQueries({ queryKey: ["skill", s.id] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSkill(s.id, projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const error = toggle.error ?? update.error ?? remove.error;
  const link = githubUrl(s);

  return (
    <li className="bg-panel">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span aria-hidden="true" className="flex size-9 flex-none items-center justify-center rounded-lg bg-hover text-muted">
          <BookMarked size={17} />
        </span>
        <div className={cn("min-w-0 flex-1", !s.enabled && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <code className="truncate font-mono text-[13px] font-medium text-fg">{s.name}</code>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-subtle">{s.description}</p>
          <div className="mt-0.5 text-[11px] text-subtle">
            <SourceLabel skill={s} />
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          {s.canEdit && (
            <Switch
              className="mx-1.5"
              checked={s.enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
              aria-label={t("skills.enabledLabel", { name: s.name })}
              title={s.enabled ? t("skills.on") : t("skills.off")}
            />
          )}
          <IconButton
            type="button"
            className="size-8"
            aria-expanded={open}
            aria-label={open ? t("skills.hideDetails") : t("skills.showDetails")}
            title={open ? t("skills.hideDetails") : t("skills.showDetails")}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown size={16} className={cn("transition-transform", open && "rotate-180")} />
          </IconButton>
          {(s.canEdit || link) && (
            <Menu
              label={t("skills.actions", { name: s.name })}
              align="end"
              panelClassName="min-w-48"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
              trigger={<MoreHorizontal size={16} />}
            >
              {(close) => (
                <>
                  {s.canEdit && s.source.kind === "write" && (
                    <MenuItem
                      icon={<Pencil size={14} />}
                      onSelect={() => {
                        close();
                        setEditing(true);
                        setOpen(false);
                      }}
                    >
                      {t("skills.edit")}
                    </MenuItem>
                  )}
                  {s.canEdit && s.source.kind === "github" && (
                    <MenuItem
                      icon={<RefreshCw size={14} />}
                      onSelect={() => {
                        close();
                        setNotice(null);
                        update.mutate();
                      }}
                    >
                      {t("skills.updateFromGithub")}
                    </MenuItem>
                  )}
                  {link && (
                    <MenuItem
                      icon={<ExternalLink size={14} />}
                      onSelect={() => {
                        close();
                        openLink(link);
                      }}
                    >
                      {t("skills.openGithub")}
                    </MenuItem>
                  )}
                  {s.canEdit && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        icon={<Trash2 size={14} />}
                        className="text-bad hover:text-bad"
                        onSelect={async () => {
                          close();
                          const ok = await confirm({
                            title: t("skills.deleteConfirm", { name: s.name }),
                            body: projectId ? t("skills.deleteBodyProject") : t("skills.deleteBody"),
                            action: t("skills.delete"),
                            danger: true,
                          });
                          if (ok) remove.mutate();
                        }}
                      >
                        {t("skills.delete")}
                      </MenuItem>
                    </>
                  )}
                </>
              )}
            </Menu>
          )}
        </div>
      </div>
      {update.isPending && (
        <p className="-mt-1 flex items-center gap-1.5 px-3.5 pb-3 pl-[62px] text-xs text-subtle">
          <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
          {t("skills.updating")}
        </p>
      )}
      {notice && !update.isPending && <p className="-mt-1 px-3.5 pb-3 pl-[62px] text-xs text-ok">{notice}</p>}
      {error && <p className="-mt-1 px-3.5 pb-3 pl-[62px] text-xs text-bad">{skillError(error, t)}</p>}
      {open && !editing && <SkillDetails skill={s} projectId={projectId} />}
      {editing && (
        <div className="border-t border-line p-3.5">
          <WriteForm
            projectId={projectId}
            existing={s}
            onDone={(next) => {
              if (next) replace(next);
              setEditing(false);
              void queryClient.invalidateQueries({ queryKey: ["skill", s.id] });
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </li>
  );
}

function SourceLabel({ skill: s }: { skill: Skill }) {
  const t = useT();
  if (s.source.kind === "github") {
    return (
      <span className="inline-flex items-center gap-1">
        <GitBranch size={11} aria-hidden="true" />
        <span className="font-mono">
          {s.source.repo}
          {s.source.path ? `/${s.source.path}` : ""}@{s.source.commit.slice(0, 7)}
        </span>
      </span>
    );
  }
  return <span>{s.source.kind === "write" ? t("skills.source.write") : t("skills.source.upload")}</span>;
}

function SkillDetails({ skill: s, projectId }: { skill: Skill; projectId?: string }) {
  const t = useT();
  const detail = useQuery({ queryKey: ["skill", s.id, s.updatedAt], queryFn: () => api.getSkill(s.id, projectId) });
  return (
    <div className="space-y-3 border-t border-line px-3.5 py-3 sm:pl-[62px]">
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted">{t("skills.files", { count: s.files.length, size: formatSize(s.size) })}</div>
        <ul className="max-h-40 space-y-0.5 overflow-y-auto">
          {s.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 text-xs">
              <FileText size={12} className="flex-none text-subtle" aria-hidden="true" />
              <code className="min-w-0 flex-1 truncate font-mono text-body">{f.path}</code>
              <span className="flex-none text-subtle">{formatSize(f.size)}</span>
            </li>
          ))}
        </ul>
      </div>
      {detail.isPending ? (
        <LoaderCircle size={14} className="animate-spin text-subtle" aria-hidden="true" />
      ) : detail.error ? (
        <p className="text-xs text-bad">{skillError(detail.error, t)}</p>
      ) : (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-raised p-3 font-mono text-xs leading-relaxed text-body">
          {detail.data.skillMd}
        </pre>
      )}
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// --- adding ---

function GithubForm({ projectId, onDone, onCancel }: { projectId?: string; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const id = useId();
  const [source, setSource] = useState("");
  const [choices, setChoices] = useState<SkillChoices["skills"] | null>(null);
  const add = useMutation({
    mutationFn: (input: Extract<CreateSkillInput, { kind: "github" }>) => api.createSkill(input, projectId),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && (err.body as { error?: string } | null)?.error === "choose_skill") {
        setChoices((err.body as SkillChoices).skills);
      }
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setChoices(null);
    add.mutate({ kind: "github", source });
  };
  const choosing = !!choices && !add.isPending;

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-edge bg-panel p-3.5">
      <Field label={t("skills.githubLabel")} hint={t("skills.githubHint")}>
        <Input
          id={id}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setChoices(null);
          }}
          placeholder="anthropics/skills"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      {choosing && (
        <div className="space-y-2">
          <p className="text-[13px] text-muted">{t("skills.chooseOne", { count: choices.length })}</p>
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-edge">
            {choices.map((c) => (
              <li key={c.path} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-[13px] text-fg">{c.name}</code>
                  {c.description && <p className="mt-0.5 line-clamp-2 text-xs text-subtle">{c.description}</p>}
                </div>
                <GhostButton type="button" onClick={() => add.mutate({ kind: "github", source, skill: c.name })}>
                  <Plus size={14} aria-hidden="true" />
                  {t("skills.add")}
                </GhostButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      {add.error && !choices && <Notice tone="bad">{skillError(add.error, t)}</Notice>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => openLink(SKILLS_DIRECTORY)}
          className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline"
        >
          <Search size={13} aria-hidden="true" />
          {t("skills.searchDirectory")}
        </button>
        <div className="flex items-center gap-2">
          <GhostButton type="button" onClick={onCancel} className="h-9 px-3">
            {t("skills.cancel")}
          </GhostButton>
          <Button type="submit" disabled={!source.trim() || add.isPending}>
            {add.isPending && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
            {t("skills.add")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function WriteForm({
  projectId,
  existing,
  onDone,
  onCancel,
}: {
  projectId?: string;
  existing?: Skill;
  onDone: (skill?: Skill) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const detail = useQuery({
    queryKey: ["skill", existing?.id ?? "", existing?.updatedAt ?? ""],
    queryFn: () => api.getSkill(existing!.id, projectId),
    enabled: !!existing,
  });
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [instructions, setInstructions] = useState<string | null>(existing ? null : "");
  // An edit starts from the stored instructions once they arrive.
  const body = instructions ?? (detail.data ? bodyOf(detail.data.skillMd) : "");
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.updateSkill(existing.id, { description, instructions: body }, projectId)
        : api.createSkill({ kind: "write", name, description, instructions: body }, projectId),
    onSuccess: (skill) => onDone(skill),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className={cn("space-y-3", !existing && "rounded-xl border border-edge bg-panel p-3.5")}
    >
      {!existing && (
        <Field label={t("skills.name")} hint={t("skills.nameHint")}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="weekly-report"
            maxLength={64}
            autoFocus
            spellCheck={false}
          />
        </Field>
      )}
      <Field label={t("skills.descriptionLabel")} hint={t("skills.descriptionHint")}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1024} />
      </Field>
      <Field label={t("skills.instructions")}>
        <textarea
          value={body}
          onChange={(e) => setInstructions(e.target.value)}
          rows={10}
          placeholder={t("skills.instructionsPlaceholder")}
          className="w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-subtle focus:border-accent"
        />
      </Field>
      {save.error && <Notice tone="bad">{skillError(save.error, t)}</Notice>}
      <div className="flex items-center justify-end gap-2">
        <GhostButton type="button" onClick={onCancel} className="h-9 px-3">
          {t("skills.cancel")}
        </GhostButton>
        <Button type="submit" disabled={(!existing && !name) || !description.trim() || save.isPending}>
          {save.isPending && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          {existing ? t("skills.save") : t("skills.add")}
        </Button>
      </div>
    </form>
  );
}

/** A SKILL.md without its front matter. */
function bodyOf(md: string) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "").trim();
}
