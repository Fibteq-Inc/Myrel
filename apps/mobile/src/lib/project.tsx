import {
  applyEvent,
  applyMessage,
  emptyProjectState,
  ProjectSocket,
  type ProjectState,
  type SocketStatus,
} from "@altair/client";
import type { ClientEventInput } from "@altair/protocol";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppState } from "react-native";
import { useApi } from "./session";

type Action =
  | Parameters<typeof applyEvent>[1]
  | { type: "reset" }
  | { type: "idle" }
  | { type: "message"; message: Parameters<typeof applyMessage>[1] };

function reducer(state: ProjectState, action: Action): ProjectState {
  if (action.type === "reset") return emptyProjectState;
  if (action.type === "idle") return { ...state, active: {} };
  if (action.type === "message") return applyMessage(state, action.message);
  return applyEvent(state, action);
}

type ProjectValue = {
  projectId: string;
  state: ProjectState;
  status: SocketStatus;
  send(body: string, threadId?: string | null): void;
  emit(event: ClientEventInput): void;
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
  const api = useApi();
  const [state, dispatch] = useReducer(reducer, emptyProjectState);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<ProjectSocket | null>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    const socket = new ProjectSocket({
      url: () => api.projectSocketUrl(projectId),
      onMessage: (message) => dispatch({ type: "message", message }),
      onEvent: (event) => dispatch(event),
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
  }, [api, projectId]);

  const send = useCallback(
    (body: string, threadId: string | null = null) => socketRef.current?.sendMessage(body, { threadId }),
    [],
  );
  const emit = useCallback((event: ClientEventInput) => socketRef.current?.send(event), []);
  const value = useMemo<ProjectValue>(
    () => ({ projectId, state, status, send, emit }),
    [projectId, state, status, send, emit],
  );
  return <ProjectContext value={value}>{children}</ProjectContext>;
}
