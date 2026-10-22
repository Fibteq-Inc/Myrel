import type { ComputerAccess, ComputerInfo, ComputerStatus, LocalComputer } from "@myrel/client";
import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliId } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { useEffect } from "react";
import { api, platform, runnersQuery, server } from "../lib/api";
import { Button, errorMessage, GhostButton } from "../lib/ui";
import { OnlineDot } from "./runners";

const ACCESS: { value: ComputerAccess; label: MessageKey }[] = [
  { value: "read", label: "thisComputer.accessRead" },
  { value: "edit", label: "thisComputer.accessEdit" },
  { value: "auto", label: "thisComputer.accessAuto" },
  { value: "full", label: "thisComputer.accessFull" },
];

const INFO_KEY = ["this-computer"];

/**
 * Desktop app only: connects the computer the app runs on with one click, using the bundled
 * myrel-runner, instead of the terminal steps. Its folders are managed in the list below like
 * any other computer's.
 */
export function ThisComputer() {
  const computer = platform.computer;
  if (!computer) return null;
  return <ThisComputerCard computer={computer} />;
}

function ThisComputerCard({ computer }: { computer: LocalComputer }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: info, error } = useQuery({ queryKey: INFO_KEY, queryFn: () => computer.info() });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: INFO_KEY });
    void queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey });
  };

  useEffect(
    () =>
      computer.onStatus((status) => {
        queryClient.setQueryData<ComputerInfo>(INFO_KEY, (old) => old && { ...old, status });
        void queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey });
      }),
    [computer, queryClient],
  );

  const origin = server || location.origin;
  const connect = useMutation({
    mutationFn: async () => {
      if (!info) return;
      const { code } = await api.createPairingCode();
      const paired = await api.pairRunner({ code, name: info.hostname, hostname: info.hostname, platform: info.platform });
      await computer.connect({ server: origin, runnerId: paired.runner.id, token: paired.token });
    },
    onSuccess: refresh,
  });
  const setAccess = useMutation({ mutationFn: (a: ComputerAccess) => computer.setAccess(a), onSuccess: refresh });
  const start = useMutation({ mutationFn: () => computer.start(), onSuccess: refresh });
  const disconnect = useMutation({
    mutationFn: async () => {
      if (info?.runnerId) await api.removeRunner(info.runnerId).catch(() => {});
      await computer.disconnect();
    },
    onSuccess: refresh,
  });

  const failure = error ?? connect.error ?? setAccess.error ?? start.error ?? disconnect.error;
  const pairedHere = info?.paired && info.server === origin;
  const running = info && ["online", "connecting", "offline"].includes(info.status.state);

  function statusText(status: ComputerStatus) {
    switch (status.state) {
      case "online":
        return t("thisComputer.online", { name: status.name });
      case "connecting":
        return t("thisComputer.connecting");
      case "offline":
        return t("thisComputer.reconnecting");
      case "error":
        return status.message || t("thisComputer.crashed");
      case "stopped":
        if (status.reason === "revoked") return t("thisComputer.removed");
        if (status.reason === "replaced") return t("thisComputer.replaced");
        return t("thisComputer.notRunning");
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-edge bg-raised p-5" aria-label={t("thisComputer.title")}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-edge bg-panel text-muted">
          <Laptop size={18} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t("thisComputer.title")}</span>
          <span className="flex items-center gap-1.5 text-xs text-subtle">
            {pairedHere ? (
              <>
                <OnlineDot online={info.status.state === "online"} />
                {statusText(info.status)}
              </>
            ) : info?.paired && info.server ? (
              t("thisComputer.otherServer", { host: new URL(info.server).host })
            ) : (
              t("thisComputer.intro")
            )}
          </span>
        </span>
        {pairedHere ? (
          <span className="flex items-center gap-1.5">
            {!running && (
              <GhostButton type="button" disabled={start.isPending} onClick={() => start.mutate()}>
                {t("thisComputer.start")}
              </GhostButton>
            )}
            <GhostButton type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {t("thisComputer.disconnect")}
            </GhostButton>
          </span>
        ) : (
          info && (
            <Button type="button" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? t("thisComputer.connecting") : t("thisComputer.connect")}
            </Button>
          )
        )}
      </div>

      {info && (
        <div className="flex flex-wrap items-center gap-1.5">
          {info.clis.length === 0 ? (
            <span className="text-xs text-subtle">{t("thisComputer.noCli")}</span>
          ) : (
            info.clis.map((c) => (
              <span key={c.id} className="rounded-md border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-muted">
                {CLI_NAMES[c.id as CliId] ?? c.id}
              </span>
            ))
          )}
          {pairedHere && (
            <label className="ml-auto flex items-center gap-2 text-xs text-subtle">
              {t("thisComputer.access")}
              <select
                value={info.access}
                disabled={setAccess.isPending}
                onChange={(e) => setAccess.mutate(e.target.value as ComputerAccess)}
                className="rounded-md border border-edge bg-panel px-2 py-1 text-[13px] text-fg"
              >
                {ACCESS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {t(a.label)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {failure && <p className="text-sm text-bad">{errorMessage(failure, t)}</p>}
    </section>
  );
}
