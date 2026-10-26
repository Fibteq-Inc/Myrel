import {
  applyConversationPage,
  applyEvent,
  applyMessages,
  applyPullRequests,
  applyTasks,
  emptyProjectState,
  ProjectSocket,
  type ProjectState,
  type SocketStatus,
} from "@myrel/client";
import { type CliId, type ClientEventInput, CONVERSATION_PAGE_SIZE, type ConversationPage, type Message } from "@myrel/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, queryClient, runnersQuery, workspaceQuery } from "./api";

type Action =
  | Parameters<typeof applyEvent>[1]
  | { type: "idle" }
  | { type: "messages"; messages: Message[] }
  | { type: "tasks"; tasks: Parameters<typeof applyTasks>[1] }
  | { type: "pullRequests"; pullRequests: Parameters<typeof applyPullRequests>[1] }
  | { type: "page"; threadId: string | null; page: ConversationPage }
  | { type: "batch"; actions: Action[] };

function reducer(state: ProjectState, action: Action): ProjectState {
  if (action.type === "batch") return action.actions.reduce(reducer, state);
  if (action.type === "idle") return { ...state, active: {}, progress: {} };
  if (action.type === "messages") return applyMessages(state, action.messages);
  if (action.type === "tasks") return applyTasks(state, action.tasks);
  if (action.type === "pullRequests") return applyPullRequests(state, action.pullRequests);
  if (action.type === "page") return applyConversationPage(state, action.threadId, action.page);
  return applyEvent(state, action);
}

/** How long socket frames are gathered before they are applied together (about one screen frame). */
const FLUSH_MS = 16;

/**
 * Projects opened in this tab, as they were when last left. Opening one again
 * shows it at once and the socket only fetches what came after.
 */
const cache = new Map<string, { state: ProjectState; seq: number }>();

/** Live state of one project: messages, threads, reactions and who is working. */
export function useProject(projectId: string) {
  const [state, dispatch] = useReducer(reducer, projectId, (id) => cache.get(id)?.state ?? emptyProjectState);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  /** The first sync has finished (or the project was in the cache): an empty chat is really empty. */
  const [ready, setReady] = useState(() => cache.has(projectId));
  const socketRef = useRef<ProjectSocket | null>(null);

  useEffect(() => {
    // Socket frames arrive one at a time; apply them together about once per screen frame,
    // so a long sync or a busy terminal doesn't redraw the whole project for every line.
    let queued: Action[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const actions = queued;
      queued = [];
      if (actions.length) dispatch({ type: "batch", actions });
    };
    const queue = (action: Action) => {
      queued.push(action);
      // A timer rather than requestAnimationFrame, which stops in a background tab.
      timer ??= setTimeout(flush, FLUSH_MS);
    };

    const socket = new ProjectSocket({
      url: () => api.projectSocketUrl(projectId),
      lastSeq: cache.get(projectId)?.seq,
      // Only the project chat's newest messages; threads load when opened, earlier pages on scrolling up.
      recent: CONVERSATION_PAGE_SIZE,
      onMessages: (messages) => queue({ type: "messages", messages }),
      onEvent: (event) => {
        // Files, memory and instructions are fetched over HTTP; refetch the list that changed.
        if (event.type === "knowledge.changed") {
          void queryClient.invalidateQueries({ queryKey: ["projects", projectId, event.kind] });
        }
        if (event.type === "workspace.changed") {
          void queryClient.invalidateQueries({ queryKey: workspaceQuery(projectId).queryKey });
          void queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey });
        }
        queue(event);
      },
      onSynced: () => {
        flush();
        setReady(true);
      },
      onStatus: (s) => {
        setStatus(s);
        // Activity is not replayed; after reconnecting, the sync re-sends what is still running.
        if (s !== "open") queue({ type: "idle" });
      },
    }).connect();
    socketRef.current = socket;
    return () => {
      clearTimeout(timer);
      socket.close();
      socketRef.current = null;
    };
  }, [projectId]);

  // Remember where this project was left, for the next time it opens: the socket knows how far it caught up,
  // which is past the newest message held when the newest ones are in threads not opened yet.
  useEffect(() => {
    const seq = socketRef.current?.seq ?? 0;
    if (ready && seq > 0) cache.set(projectId, { state: { ...state, active: {}, progress: {} }, seq });
  }, [projectId, ready, state]);

  const send = useCallback(
    (body: string, threadId: string | null = null, attachments: string[] = [], clis: CliId[] = []) =>
      socketRef.current?.sendMessage(body, { threadId, attachments, clis }),
    [],
  );
  const emit = useCallback((event: ClientEventInput) => socketRef.current?.send(event), []);
  /** Loads a thread's tasks with their earlier terminal output, and the pull requests they opened. */
  const loadTasks = useCallback(
    async (threadId: string) => {
      const [tasks, pullRequests] = await Promise.all([api.listTasks(projectId, threadId), api.listPullRequests(projectId, threadId)]);
      dispatch({ type: "tasks", tasks });
      dispatch({ type: "pullRequests", pullRequests });
    },
    [projectId],
  );

  /** Fetches a conversation's newest page (null: the project chat), or the page before `beforeSeq`. */
  const loadConversation = useCallback(
    async (threadId: string | null, beforeSeq?: number) => {
      const page = await api.getConversationPage(projectId, threadId, beforeSeq);
      dispatch({ type: "page", threadId, page });
    },
    [projectId],
  );

  return { state, status, ready, send, emit, loadTasks, loadConversation };
}
