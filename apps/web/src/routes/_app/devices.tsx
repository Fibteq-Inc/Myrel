import type { Runner, RunnerPairingCode } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Folder, FolderPlus, MonitorSmartphone, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { FolderPicker, folderPickerBlocker } from "../../components/folder-picker";
import { NavToggle } from "../../components/shell/shell";
import { CliChips, lastSeen, OnlineDot, PairingSteps, RunnerIcon } from "../../components/runners";
import { api, runnersQuery, server } from "../../lib/api";
import { Button, errorMessage, GhostButton, IconButton } from "../../lib/ui";

export const Route = createFileRoute("/_app/devices")({
  component: DevicesPage,
});

function DevicesPage() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<RunnerPairingCode | null>(null);
  const [pairedBefore, setPairedBefore] = useState<Set<string>>(new Set());
  // While the pairing steps are open, watch for the new computer to appear.
  const { data: runners = [], isPending } = useQuery({ ...runnersQuery, refetchInterval: pairing ? 3000 : 15_000 });
  const newRunner = pairing ? runners.find((r) => !pairedBefore.has(r.id)) : undefined;

  const createCode = useMutation({
    mutationFn: () => api.createPairingCode(),
    onSuccess: (code) => {
      setPairedBefore(new Set(runners.map((r) => r.id)));
      setPairing(code);
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4 sm:px-5">
        <NavToggle />
        <MonitorSmartphone size={17} className="text-muted" aria-hidden="true" />
        <h1 className="text-[15px] font-semibold">Devices</h1>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 py-7 sm:px-6">
          <section className="flex flex-col gap-3">
            <p className="text-body">
              Connect your own computer so a project can work in one of your local folders, using the Claude Code, Codex
              or Gemini CLI you already pay for. Altair sends the task; the CLI runs on your computer with your own
              login.
            </p>
            {!pairing && (
              <div>
                <Button type="button" onClick={() => createCode.mutate()} disabled={createCode.isPending}>
                  <Plus size={16} aria-hidden="true" />
                  Connect a computer
                </Button>
              </div>
            )}
            {createCode.error && <p className="text-sm text-bad">{errorMessage(createCode.error)}</p>}
          </section>

          {pairing && (
            <section className="rounded-xl border border-edge bg-raised p-5" aria-label="Connect a computer">
              <div className="mb-4 flex items-center gap-2">
                <h2 className="font-semibold">Connect a computer</h2>
                <span className="ml-2 rounded-md bg-accent-soft px-2 py-0.5 font-mono text-[13px] tracking-wider text-accent">
                  {pairing.code}
                </span>
                <IconButton type="button" aria-label="Close" className="ml-auto size-8" onClick={() => setPairing(null)}>
                  <X size={16} />
                </IconButton>
              </div>
              {newRunner ? (
                <div className="flex items-center gap-3 rounded-lg border border-[#1f3b2d] bg-[#0f1a14] px-3.5 py-3">
                  <OnlineDot online={newRunner.online} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{newRunner.name}</span> is paired.{" "}
                    {newRunner.online
                      ? "It's connected. Add a folder to it below, then pick it from a project's header."
                      : "Run step 2 on it to connect."}
                  </span>
                  <GhostButton type="button" onClick={() => setPairing(null)}>
                    Done
                  </GhostButton>
                </div>
              ) : (
                <PairingSteps pairing={pairing} server={server || location.origin} />
              )}
            </section>
          )}

          <section className="flex flex-col gap-3" aria-label="Your computers">
            <h2 className="text-xs text-subtle">Your computers</h2>
            {isPending ? null : runners.length === 0 ? (
              <p className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-[13px] text-subtle">
                No computers yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {runners.map((r) => (
                  <RunnerRow
                    key={r.id}
                    runner={r}
                    onRemoved={() => queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey })}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function RunnerRow({ runner, onRemoved }: { runner: Runner; onRemoved: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const remove = useMutation({ mutationFn: () => api.removeRunner(runner.id), onSuccess: onRemoved });
  const unshare = useMutation({
    mutationFn: (path: string) => api.unshareRunnerFolder(runner.id, path),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey }),
  });
  const blocker = folderPickerBlocker(runner);
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-edge bg-panel text-muted">
          <RunnerIcon runner={runner} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{runner.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-subtle">
            <OnlineDot online={runner.online} />
            {lastSeen(runner)}
            {runner.version && <span className="hidden sm:inline">· altair-runner {runner.version}</span>}
          </span>
        </span>
        {confirming ? (
          <span className="flex items-center gap-1.5">
            <span className="hidden text-xs text-muted sm:inline">Remove it?</span>
            <GhostButton type="button" onClick={() => setConfirming(false)}>
              Cancel
            </GhostButton>
            <GhostButton
              type="button"
              className="border-[#4a2422] text-bad hover:bg-[#1f1212]"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </GhostButton>
          </span>
        ) : (
          <IconButton type="button" aria-label={`Remove ${runner.name}`} title="Remove" onClick={() => setConfirming(true)}>
            <Trash2 size={16} />
          </IconButton>
        )}
      </div>
      <CliChips runner={runner} />
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs text-subtle">Shared folders</h3>
          {!adding && (
            <GhostButton
              type="button"
              className="ml-auto h-7 px-2 text-xs"
              disabled={Boolean(blocker)}
              title={blocker ?? undefined}
              onClick={() => setAdding(true)}
            >
              <FolderPlus size={14} aria-hidden="true" />
              Add folder
            </GhostButton>
          )}
        </div>
        {runner.folders.length === 0 && !adding && (
          <p className="text-[13px] text-subtle">{blocker ?? "None yet. Add the folders projects may work in."}</p>
        )}
        {runner.folders.length > 0 && (
          <ul className="flex flex-col">
            {runner.folders.map((f) => (
              <li key={f.path} className="group flex items-center gap-2 rounded-md py-1 text-[13px] text-muted">
                <Folder size={14} className="flex-none text-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={f.path}>
                  {f.path}
                </span>
                {!blocker && (
                  <IconButton
                    type="button"
                    aria-label={`Stop sharing ${f.path}`}
                    title="Stop sharing"
                    className="size-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    disabled={unshare.isPending}
                    onClick={() => unshare.mutate(f.path)}
                  >
                    <X size={14} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {adding && (
          <FolderPicker
            runner={runner}
            className="mt-2"
            onShared={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
      {(remove.error || unshare.error) && (
        <p className="text-sm text-bad">{errorMessage(remove.error ?? unshare.error)}</p>
      )}
    </li>
  );
}
