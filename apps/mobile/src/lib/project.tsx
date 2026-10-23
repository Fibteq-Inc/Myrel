import {
  applyEvent,
  applyMessages,
  applyPullRequests,
  applyTasks,
  emptyProjectState,
  ProjectSocket,
  type ProjectState,
  type SocketStatus,
} from "@myrel/client";
import type { CliId, ClientEventInput } from "@myrel/protocol";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppState } from "react-native";
import { filesQueryKey, runnersQueryKey, workspaceQueryKey } from "./queries";
import { useSession } from "./session";

type Action =
  | Parameters<typeof applyEvent>[1]
  | { type: "reset" }
  | { type: "idle" }
  | { type: "messages"; messages: Parameters<typeof applyMessages>[1] }
  | { type: "tasks"; tasks: Parameters<typeof applyTasks>[1] }
  | { type: "pullRequests"; pullRequests: Parameters<typeof applyPullRequests>[1] };

function reducer(state: ProjectState, action: Action): ProjectState {
  if (action.type === "reset") return emptyProjectState;
  if (action.type === "idle") return { ...state, active: {} };
  if (action.type === "messages") return applyMessages(state, action.messages);
  if (action.type === "tasks") return applyTasks(state, action.tasks);
  if (action.type === "pullRequests") return applyPullRequests(state, action.pullRequests);
  return applyEvent(state, action);
}

type ProjectValue = {
  projectId: string;
  state: ProjectState;
  status: SocketStatus;
  send(body: string, threadId?: string | null, attachments?: string[], clis?: CliId[]): void;
  emit(event: ClientEventInput): void;
  /** Loads a thread's tasks with their earlier terminal output, and the pull requests they opened. */
  loadTasks(threadId: string): Promise<void>;
};

const ProjectContext = createContext<ProjectValue | null>(null);

export function useProject() {
  const value = use(ProjectContext);
  if (!value) throw new Error("useProject outside ProjectProvider");
  return value;
}

/**
 * Live state of one project, shared by its chat and thread screens. The
 * socket closes while the app is in the background (the OS would kill it
 * anyway; push notifications cover that time) and catches up by seq on return.
 */
export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, emptyProjectState);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<ProjectSocket | null>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    const socket = new ProjectSocket({
      url: () => api.projectSocketUrl(projectId),
      // A sync page lands in one update instead of one per message.
      onMessages: (messages) => dispatch({ type: "messages", messages }),
      onEvent: (event) => {
        if (event.type === "knowledge.changed" && event.kind === "files") {
          void queryClient.invalidateQueries({ queryKey: filesQueryKey(server, projectId) });
        }
        // The folder, its computer or that computer's CLIs changed: the CLI picker follows.
        if (event.type === "workspace.changed") {
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKey(server, projectId) });
          void queryClient.invalidateQueries({ queryKey: runnersQueryKey(server) });
        }
        dispatch(event);
      },
      onStatus: (s) => {
        setStatus(s);
        // Activity is not replayed; after reconnecting, the sync re-sends what is still running.
        if (s !== "open") dispatch({ type: "idle" });
      },
    }).connect();
    socketRef.current = socket;

    let paused = false;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" && !paused) {
        paused = true;
        socket.close();
      } else if (next === "active" && paused) {
        paused = false;
        socket.connect();
      }
    });
    return () => {
      sub.remove();
      socket.close();
    };
  }, [api, server, projectId, queryClient]);

  const send = useCallback(
    (body: string, threadId: string | null = null, attachments?: string[], clis?: CliId[]) =>
      socketRef.current?.sendMessage(body, { threadId, attachments, clis }),
    [],
  );
  const emit = useCallback((event: ClientEventInput) => socketRef.current?.send(event), []);
  const loadTasks = useCallback(
    async (threadId: string) => {
      const [tasks, pullRequests] = await Promise.all([api.listTasks(projectId, threadId), api.listPullRequests(projectId, threadId)]);
      dispatch({ type: "tasks", tasks });
      dispatch({ type: "pullRequests", pullRequests });
    },
    [api, projectId],
  );
  const value = useMemo<ProjectValue>(
    () => ({ projectId, state, status, send, emit, loadTasks }),
    [projectId, state, status, send, emit, loadTasks],
  );
  return <ProjectContext value={value}>{children}</ProjectContext>;
}
