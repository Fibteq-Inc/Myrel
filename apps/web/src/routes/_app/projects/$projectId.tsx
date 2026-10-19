import { ProjectSocket, type SocketStatus } from "@altair/client";
import type { Message } from "@altair/protocol";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, projectQuery } from "../../../lib/api";
import { Button } from "../../../lib/ui";

export const Route = createFileRoute("/_app/projects/$projectId")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(params.projectId)),
  component: ProjectChat,
});

function useProjectSocket(projectId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<ProjectSocket | null>(null);

  useEffect(() => {
    setMessages([]);
    const socket = new ProjectSocket({
      url: () => api.projectSocketUrl(projectId),
      onMessage: (m) => setMessages((prev) => [...prev, m]),
      onStatus: setStatus,
    }).connect();
    socketRef.current = socket;
    return () => socket.close();
  }, [projectId]);

  return { messages, status, send: (body: string) => socketRef.current?.sendMessage(body) };
}

function ProjectChat() {
  const { projectId } = Route.useParams();
  const { user } = Route.useRouteContext();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { messages, status, send } = useProjectSocket(projectId);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [messages.length]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    send(body);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="font-semibold">{project.name}</h1>
        <span className="text-xs text-neutral-500">{status}</span>
      </div>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4">
        {messages.length === 0 && <li className="py-12 text-center text-sm text-neutral-500">No messages yet.</li>}
        {messages.map((m) => (
          <li key={m.id}>
            <div className="text-xs text-neutral-500">
              {m.authorId === user.id ? "You" : m.authorKind === "user" ? m.authorId : m.authorKind} ·{" "}
              {new Date(m.createdAt).toLocaleTimeString()}
            </div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </li>
        ))}
        <div ref={bottomRef} />
      </ol>
      <form onSubmit={submit} className="flex items-end gap-2 border-t border-neutral-200 p-4 dark:border-neutral-800">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Message the project…"
          className="flex-1 resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
        <Button type="submit" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
