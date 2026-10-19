import {
  applyEvent,
  applyMessage,
  emptyProjectState,
  ProjectSocket,
  type ProjectState,
  type SocketStatus,
} from "@altair/client";
import type { ClientEventInput } from "@altair/protocol";
import { useEffect, useReducer, useRef, useState } from "react";
import { api } from "./api";

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

/** Live state of one project: messages, threads, reactions and who is working. */
export function useProject(projectId: string) {
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
    return () => socket.close();
  }, [projectId]);

  return {
    state,
    status,
    send: (body: string, threadId: string | null = null) => socketRef.current?.sendMessage(body, { threadId }),
    emit: (event: ClientEventInput) => socketRef.current?.send(event),
  };
}
