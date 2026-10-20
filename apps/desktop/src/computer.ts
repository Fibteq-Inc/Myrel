import type { ComputerAccess, ComputerInfo, ComputerStatus, LocalComputer } from "@myrel/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The bundled myrel-runner sidecar, driven by the commands in src-tauri/src/runner.rs. */
export function desktopComputer(): LocalComputer {
  return {
    info: () => invoke<ComputerInfo>("runner_info"),
    connect: ({ server, runnerId, token }) => invoke("runner_connect", { server, runnerId, token }),
    setAccess: (access: ComputerAccess) => invoke("runner_set_access", { access }),
    start: () => invoke("runner_start"),
    disconnect: () => invoke("runner_logout"),
    onStatus(listener) {
      const unlisten = listen<ComputerStatus | { state: "task" }>("runner://status", ({ payload }) => {
        if (payload.state !== "task") listener(payload);
      });
      return () => void unlisten.then((stop) => stop());
    },
  };
}
