import type { MessageKey } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { MEMORY_INDEX, type MemoryEntry } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, FolderOpen, Plus, ScrollText, Trash2, Upload } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, filesQuery, instructionsQuery, memoryQuery } from "../lib/api";
import { Button, errorMessage, GhostButton, Input } from "../lib/ui";
import { displayName, FileIcon, FilePreview, formatSize } from "./files";
import { useConfirm } from "./ui/confirm";

export type PanelTab = "files" | "memory" | "instructions";

const TABS: { id: PanelTab; label: MessageKey; icon: ReactNode }[] = [
  { id: "files", label: "knowledge.tabFiles", icon: <FolderOpen size={15} aria-hidden="true" /> },
  { id: "memory", label: "knowledge.tabMemory", icon: <Brain size={15} aria-hidden="true" /> },
  { id: "instructions", label: "knowledge.tabInstructions", icon: <ScrollText size={15} aria-hidden="true" /> },
];

/**
 * The project's shared knowledge, one tab at a time: files (with a preview
 * beside the list), memory and instructions. Rendered by the project's
 * /files route, under the shell's pane header.
 */
export function ProjectKnowledge({
  projectId,
  tab,
  file,
  onNavigate,
}: {
  projectId: string;
  tab: PanelTab;
  file?: string;
  onNavigate: (next: { tab: PanelTab; file?: string }) => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label={t("knowledge.label")} className="flex flex-none gap-1 border-b border-line px-3 py-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => onNavigate({ tab: item.id })}
            className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] ${
              tab === item.id ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            {item.icon}
            {t(item.label)}
          </button>
        ))}
      </div>
      {tab === "files" && (
        <div className="flex min-h-0 flex-1">
          <div
            className={`min-w-0 flex-col lg:flex lg:max-w-[420px] lg:border-r lg:border-line ${
              file ? "hidden" : "flex"
            } flex-1`}
          >
            <FilesTab projectId={projectId} selected={file} onOpen={(path) => onNavigate({ tab: "files", file: path })} />
          </div>
          {file ? (
            <div className="flex min-w-0 flex-1 flex-col bg-sunken">
              <FilePreview projectId={projectId} path={file} onClose={() => onNavigate({ tab: "files" })} />
            </div>
          ) : (
            <div className="hidden flex-1 items-center justify-center text-[13px] text-subtle lg:flex">
              {t("knowledge.pickFile")}
            </div>
          )}
        </div>
      )}
      {tab === "memory" && (
        <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col">
          <MemoryTab projectId={projectId} />
        </div>
      )}
      {tab === "instructions" && (
        <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col">
          <InstructionsTab projectId={projectId} />
        </div>
      )}
    </div>
  );
}

function FilesTab({
  projectId,
  selected,
  onOpen,
}: {
  projectId: string;
  selected?: string;
  onOpen: (path: string) => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { data: files = [], isPending } = useQuery(filesQuery(projectId));
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: filesQuery(projectId).queryKey });

  const upload = useMutation({
    mutationFn: async (picked: File[]) => {
      for (const f of picked) await api.putFile(projectId, f.name, f);
    },
    onSuccess: refresh,
    onError: (err) => setError(errorMessage(err, t)),
  });

  async function remove(path: string) {
    if (!(await confirm({ title: t("knowledge.deleteFileConfirm", { path }), action: t("knowledge.delete"), danger: true }))) return;
    try {
      await api.deleteFile(projectId, path);
      await refresh();
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  // Group by folder so the list reads like a file tree.
  const folders = new Map<string, typeof files>();
  for (const f of files) {
    const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    folders.set(folder, [...(folders.get(folder) ?? []), f]);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 px-4 py-3">
        <p className="flex-1 text-[13px] text-subtle">{t("knowledge.filesIntro")}</p>
        <GhostButton type="button" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Upload size={14} aria-hidden="true" />
          {upload.isPending ? t("knowledge.uploading") : t("knowledge.upload")}
        </GhostButton>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setError(null);
            const picked = [...(e.target.files ?? [])];
            e.target.value = "";
            if (picked.length) upload.mutate(picked);
          }}
        />
      </div>
      {error && <p className="px-4 pb-2 text-[13px] text-bad">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!isPending && files.length === 0 && (
          <p className="px-2 py-10 text-center text-[13px] text-subtle">
            {t("knowledge.filesEmpty")}
          </p>
        )}
        {[...folders].map(([folder, list]) => (
          <div key={folder} className="mb-2">
            {folder && <div className="px-2 pb-1 pt-2 font-mono text-xs text-subtle">{folder}/</div>}
            <ul>
              {list.map((f) => (
                <li
                  key={f.path}
                  className={`group flex items-center rounded-lg hover:bg-hover ${f.path === selected ? "bg-hover" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => onOpen(f.path)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left"
                  >
                    <FileIcon path={f.path} contentType={f.contentType} />
                    <span className="truncate">{displayName(f.path)}</span>
                    <span className="ml-auto flex-none text-xs text-subtle">{formatSize(f.size)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(f.path)}
                    aria-label={t("knowledge.deleteFile", { path: f.path })}
                    className="mr-1 rounded p-1.5 text-subtle opacity-0 hover:text-bad focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoryTab({ projectId }: { projectId: string }) {
  const t = useT();
  const { data: memory = [], isPending } = useQuery(memoryQuery(projectId));
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const hasIndex = memory.some((m) => m.name === MEMORY_INDEX);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-none items-center gap-2 px-4 py-3">
        <p className="flex-1 text-[13px] text-subtle">
          {t("knowledge.memoryIntro", { index: MEMORY_INDEX })}
        </p>
        <GhostButton type="button" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" />
          {t("knowledge.newMemory")}
        </GhostButton>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {creating && (
          <MemoryEditor
            projectId={projectId}
            initial={{ name: hasIndex ? "" : MEMORY_INDEX, description: "", content: "" }}
            isNew
            onDone={() => setCreating(false)}
          />
        )}
        {!isPending && memory.length === 0 && !creating && (
          <p className="py-10 text-center text-[13px] text-subtle">
            {t("knowledge.memoryEmpty")}
          </p>
        )}
        {memory.map((m) =>
          editing === m.name ? (
            <MemoryEditor key={m.name} projectId={projectId} initial={m} onDone={() => setEditing(null)} />
          ) : (
            <MemoryCard key={m.name} entry={m} onEdit={() => setEditing(m.name)} />
          ),
        )}
      </div>
    </div>
  );
}

function MemoryCard({ entry, onEdit }: { entry: MemoryEntry; onEdit: () => void }) {
  const { t, locale } = useI18n();
  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex flex-col gap-1 rounded-xl border border-edge bg-raised px-3.5 py-3 text-left hover:border-edge-strong"
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{entry.name}</span>
        <span className="ml-auto text-xs text-subtle">
          {entry.updatedByKind === "agent" ? "Myrel" : t("common.member")} · {new Date(entry.updatedAt).toLocaleDateString(locale)}
        </span>
      </span>
      {entry.description && <span className="text-[13px] text-muted">{entry.description}</span>}
      <span className="line-clamp-3 whitespace-pre-wrap text-[13px] text-body">{entry.content}</span>
    </button>
  );
}

function MemoryEditor({
  projectId,
  initial,
  isNew,
  onDone,
}: {
  projectId: string;
  initial: { name: string; description: string; content: string };
  isNew?: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [content, setContent] = useState(initial.content);
  const refresh = () => queryClient.invalidateQueries({ queryKey: memoryQuery(projectId).queryKey });
  const save = useMutation({
    mutationFn: () => api.putMemory(projectId, name.trim(), { description, content }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteMemory(projectId, initial.name),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="flex flex-col gap-2 rounded-xl border border-accent/50 bg-raised p-3"
    >
      {isNew ? (
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("knowledge.memoryNamePlaceholder")}
          aria-label={t("knowledge.memoryName")}
          required
        />
      ) : (
        <span className="font-mono text-[13px] font-medium">{name}</span>
      )}
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("knowledge.memoryDescriptionPlaceholder")}
        aria-label={t("knowledge.memoryDescription")}
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={8}
        aria-label={t("knowledge.memoryContent")}
        className="w-full resize-y rounded-lg border border-edge bg-panel p-3 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
      />
      {(save.error || remove.error) && <p className="text-[13px] text-bad">{errorMessage(save.error ?? remove.error, t)}</p>}
      <div className="flex items-center gap-2">
        {!isNew && (
          <GhostButton
            type="button"
            onClick={async () => {
              if (await confirm({ title: t("knowledge.deleteMemoryConfirm", { name: initial.name }), action: t("knowledge.delete"), danger: true }))
                remove.mutate();
            }}
            className="text-bad"
          >
            <Trash2 size={14} aria-hidden="true" />
            {t("knowledge.delete")}
          </GhostButton>
        )}
        <GhostButton type="button" onClick={onDone} className="ml-auto">
          {t("knowledge.cancel")}
        </GhostButton>
        <Button type="submit" disabled={save.isPending || !name.trim()}>
          {t("knowledge.save")}
        </Button>
      </div>
    </form>
  );
}

function InstructionsTab({ projectId }: { projectId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery(instructionsQuery(projectId));
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setText(data.text);
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.setInstructions(projectId, text),
    onSuccess: async (next) => {
      queryClient.setQueryData(instructionsQuery(projectId).queryKey, next);
      setSaved(true);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
    >
      <p className="text-[13px] text-subtle">
        {t("knowledge.instructionsIntro")}
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        placeholder={t("knowledge.instructionsPlaceholder")}
        aria-label={t("knowledge.instructionsLabel")}
        className="min-h-[240px] flex-1 resize-none rounded-xl border border-edge bg-raised p-3.5 text-[13.5px] text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
      {save.error && <p className="text-[13px] text-bad">{errorMessage(save.error, t)}</p>}
      <div className="flex items-center gap-3">
        {saved && <span className="text-[13px] text-ok">{t("knowledge.saved")}</span>}
        <Button type="submit" className="ml-auto" disabled={save.isPending || text === (data?.text ?? "")}>
          {t("knowledge.saveInstructions")}
        </Button>
      </div>
    </form>
  );
}
