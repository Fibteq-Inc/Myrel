import { MEMORY_INDEX, type MemoryEntry } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, FolderOpen, Plus, ScrollText, Trash2, Upload, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, filesQuery, instructionsQuery, memoryQuery } from "../lib/api";
import { Button, errorMessage, GhostButton, IconButton, Input } from "../lib/ui";
import { displayName, FileIcon, FilePreview, formatSize } from "./files";

export type PanelTab = "files" | "memory" | "instructions";

const TABS: { id: PanelTab; label: string; icon: ReactNode }[] = [
  { id: "files", label: "Files", icon: <FolderOpen size={15} aria-hidden="true" /> },
  { id: "memory", label: "Memory", icon: <Brain size={15} aria-hidden="true" /> },
  { id: "instructions", label: "Instructions", icon: <ScrollText size={15} aria-hidden="true" /> },
];

/** The project's shared knowledge: files, memory and instructions. Opens beside the chat. */
export function ProjectPanel({
  projectId,
  tab,
  file,
  onNavigate,
  onClose,
}: {
  projectId: string;
  tab: PanelTab;
  file?: string;
  onNavigate: (next: { tab: PanelTab; file?: string }) => void;
  onClose: () => void;
}) {
  return (
    <section
      aria-label="Project knowledge"
      className="flex min-w-0 flex-1 flex-col border-l border-line bg-[#0c0c0e] lg:max-w-[600px]"
    >
      <header className="flex h-14 flex-none items-center gap-1 border-b border-line px-3">
        <div role="tablist" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => onNavigate({ tab: t.id })}
              className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] ${
                tab === t.id ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <IconButton type="button" onClick={onClose} aria-label="Close panel" className="ml-auto">
          <X size={17} />
        </IconButton>
      </header>
      {tab === "files" &&
        (file ? (
          <FilePreview projectId={projectId} path={file} onClose={() => onNavigate({ tab: "files" })} />
        ) : (
          <FilesTab projectId={projectId} onOpen={(path) => onNavigate({ tab: "files", file: path })} />
        ))}
      {tab === "memory" && <MemoryTab projectId={projectId} />}
      {tab === "instructions" && <InstructionsTab projectId={projectId} />}
    </section>
  );
}

function FilesTab({ projectId, onOpen }: { projectId: string; onOpen: (path: string) => void }) {
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
    onError: (err) => setError(errorMessage(err)),
  });

  async function remove(path: string) {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    try {
      await api.deleteFile(projectId, path);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
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
        <p className="flex-1 text-[13px] text-subtle">Shared by everyone in the project, people and Altair.</p>
        <GhostButton type="button" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Upload size={14} aria-hidden="true" />
          {upload.isPending ? "Uploading…" : "Upload"}
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
            No files yet. Upload one, attach one to a message, or ask Altair to write one.
          </p>
        )}
        {[...folders].map(([folder, list]) => (
          <div key={folder} className="mb-2">
            {folder && <div className="px-2 pb-1 pt-2 font-mono text-xs text-subtle">{folder}/</div>}
            <ul>
              {list.map((f) => (
                <li key={f.path} className="group flex items-center rounded-lg hover:bg-hover">
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
                    aria-label={`Delete ${f.path}`}
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
  const { data: memory = [], isPending } = useQuery(memoryQuery(projectId));
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const hasIndex = memory.some((m) => m.name === MEMORY_INDEX);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-none items-center gap-2 px-4 py-3">
        <p className="flex-1 text-[13px] text-subtle">
          Notes Altair keeps across threads. {MEMORY_INDEX} is read in full every turn; the rest by need.
        </p>
        <GhostButton type="button" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" />
          New
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
            Nothing remembered yet. Altair saves decisions and preferences here as you work.
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
  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex flex-col gap-1 rounded-xl border border-edge bg-raised px-3.5 py-3 text-left hover:border-[#3a3a44]"
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{entry.name}</span>
        <span className="ml-auto text-xs text-subtle">
          {entry.updatedByKind === "agent" ? "Altair" : "Member"} · {new Date(entry.updatedAt).toLocaleDateString()}
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
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. deploys" aria-label="Name" required />
      ) : (
        <span className="font-mono text-[13px] font-medium">{name}</span>
      )}
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One line: when should Altair read this?"
        aria-label="Description"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={8}
        aria-label="Content"
        className="w-full resize-y rounded-lg border border-edge bg-panel p-3 font-mono text-[12.5px] text-fg outline-none focus:border-accent"
      />
      {(save.error || remove.error) && <p className="text-[13px] text-bad">{errorMessage(save.error ?? remove.error)}</p>}
      <div className="flex items-center gap-2">
        {!isNew && (
          <GhostButton
            type="button"
            onClick={() => confirm(`Delete memory ${initial.name}?`) && remove.mutate()}
            className="text-bad"
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </GhostButton>
        )}
        <GhostButton type="button" onClick={onDone} className="ml-auto">
          Cancel
        </GhostButton>
        <Button type="submit" disabled={save.isPending || !name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

function InstructionsTab({ projectId }: { projectId: string }) {
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
        Altair follows these in every thread of this project: tone, language, conventions, what to avoid.
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        placeholder="e.g. Reply in Turkish. Our repo is acme/web; open PRs as drafts."
        aria-label="Project instructions"
        className="min-h-[240px] flex-1 resize-none rounded-xl border border-edge bg-raised p-3.5 text-[13.5px] text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
      {save.error && <p className="text-[13px] text-bad">{errorMessage(save.error)}</p>}
      <div className="flex items-center gap-3">
        {saved && <span className="text-[13px] text-ok">Saved</span>}
        <Button type="submit" className="ml-auto" disabled={save.isPending || text === (data?.text ?? "")}>
          Save instructions
        </Button>
      </div>
    </form>
  );
}
