import {
  applyEvent,
  applyMessage,
  applyTasks,
  emptyProjectState,
  ProjectSocket,
  type ProjectState,
  type SocketStatus,
} from "@altair/client";
import type { ClientEventInput } from "@altair/protocol";
import { useEffect, useReducer, useRef, useState } from "react";
import { api, queryClient, runnersQuery, workspaceQuery } from "./api";

type Action =
  | Parameters<typeof applyEvent>[1]
  | { type: "reset" }
  | { type: "idle" }
  | { type: "message"; message: Parameters<typeof applyMessage>[1] }
  | { type: "tasks"; tasks: Parameters<typeof applyTasks>[1] };

function reducer(state: ProjectState, action: Action): ProjectState {
  if (action.type === "reset") return emptyProjectState;
  if (action.type === "idle") return { ...state, active: {}, progress: {} };
  if (action.type === "message") return applyMessage(state, action.message);
  if (action.type === "tasks") return applyTasks(state, action.tasks);
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
      onEvent: (event) => {
        // Files, memory and instructions are fetched over HTTP; refetch the list that changed.
        if (event.type === "knowledge.changed") {
          void queryClient.invalidateQueries({ queryKey: ["projects", projectId, event.kind] });
        }
        if (event.type === "workspace.changed") {
          void queryClient.invalidateQueries({ queryKey: workspaceQuery(projectId).queryKey });
          void queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey });
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
    return () => socket.close();
  }, [projectId]);

  return {
    state,
    status,
    send: (body: string, threadId: string | null = null, attachments: string[] = []) =>
      socketRef.current?.sendMessage(body, { threadId, attachments }),
    emit: (event: ClientEventInput) => socketRef.current?.send(event),
    /** Loads a thread's tasks and their earlier terminal output. */
    loadTasks: async (threadId: string) => dispatch({ type: "tasks", tasks: await api.listTasks(projectId, threadId) }),
  };
}
