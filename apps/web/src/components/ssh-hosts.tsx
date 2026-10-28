import { useT } from "@myrel/i18n/react";
import type { SshTestResult } from "@myrel/client";
import { authorizedKeysCommand, type SshHost, type SshHostKey, type SshLocalKey, type SshRule, SshAlias, SshHostName, SshUser } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Server, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, runnersQuery, workspacesQuery } from "../lib/api";
import { Button, cn, errorMessage, GhostButton, IconButton, Input, useRelativeTime } from "../lib/ui";
import { CopyButton } from "./chat/markdown";
import { Badge, Field, List, Notice, Row, Section, Select } from "./settings";
import { useConfirm } from "./ui/confirm";

const sshQuery = (projectId: string) => ({ queryKey: ["projects", projectId, "ssh"], queryFn: () => api.getSsh(projectId) });

/**
 * The servers the project's agents may reach over SSH, and what they ran there. Each server's key is
 * made on one of the project's computers and never leaves it; only that computer's owner sets the
 * server up and answers its agents' cards. Owners and admins can turn a server off or remove it.
 */
export function SshHosts({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const ago = useRelativeTime();
  const { data, isPending, error } = useQuery(sshQuery(projectId));
  const { data: workspaces = [] } = useQuery(workspacesQuery(projectId));
  const { data: runners = [] } = useQuery(runnersQuery);
  // The project's computers that are yours: a server's key can go on one of them.
  const mine = workspaces.filter((w) => runners.some((r) => r.id === w.runnerId));
  const [setup, setSetup] = useState<{ host?: SshHost } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects", projectId, "ssh"] });

  const rule = useMutation({
    mutationFn: ({ host, rule }: { host: SshHost; rule: SshRule }) => api.updateSshHost(projectId, host.id, rule),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (host: SshHost) => api.deleteSshHost(projectId, host.id), onSuccess: refresh });

  if (isPending) return null;
  if (error) return <Notice>{errorMessage(error, t)}</Notice>;

  if (setup) {
    return (
      <Section title={setup.host ? t("ssh.setupTitle", { name: setup.host.alias }) : t("ssh.addTitle")}>
        <AddServer
          projectId={projectId}
          computers={mine.map((w) => ({ id: w.runnerId, name: w.runnerName, online: w.online }))}
          resume={setup.host}
          onDone={() => {
            setSetup(null);
            void refresh();
          }}
        />
      </Section>
    );
  }

  const hosts = data.hosts;
  return (
    <>
      <Section
        title={t("ssh.title")}
        description={
          <>
            {t("ssh.description")} {mine.length === 0 && t("ssh.noComputer")}
          </>
        }
      >
        <List empty={t("ssh.empty")}>
          {hosts.map((host) => {
            const ready = !!host.hostFingerprint && !!host.testedAt;
            const canOff = host.mine || canManage;
            return (
              <Row key={host.id}>
                <Server size={16} className="flex-none text-subtle" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{host.alias}</span>
                    {host.rule === "off" ? <Badge>{t("ssh.off")}</Badge> : ready ? <Badge>{t("ssh.ready")}</Badge> : <Badge>{t("ssh.notReady")}</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-subtle">
                    {host.user}@{host.host}
                    {host.port === 22 ? "" : `:${host.port}`}
                  </div>
                  <div className="text-xs text-subtle">{t("ssh.on", { computer: host.runnerName })}</div>
                </div>
                {host.mine && !ready && (
                  <GhostButton type="button" onClick={() => setSetup({ host })}>
                    {t("ssh.continueSetup")}
                  </GhostButton>
                )}
                {(host.mine || (canOff && host.rule === "ask")) && (
                  <Select
                    aria-label={t("ssh.rule")}
                    value={host.rule}
                    disabled={rule.isPending}
                    onChange={(e) => rule.mutate({ host, rule: e.target.value as SshRule })}
                    className="w-auto"
                  >
                    <option value="ask" disabled={!host.mine}>
                      {t("ssh.rule.ask")}
                    </option>
                    <option value="off">{t("ssh.rule.off")}</option>
                  </Select>
                )}
                {canOff && (
                  <IconButton
                    type="button"
                    aria-label={t("ssh.delete")}
                    title={t("ssh.delete")}
                    onClick={async () => {
                      const ok = await confirm({ title: t("ssh.deleteConfirm", { name: host.alias }), body: t("ssh.deleteBody"), action: t("ssh.delete"), danger: true });
                      if (ok) remove.mutate(host);
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </Row>
            );
          })}
        </List>
        {(rule.error || remove.error) && <Notice>{errorMessage(rule.error ?? remove.error, t)}</Notice>}
        {mine.length > 0 && (
          <Button type="button" onClick={() => setSetup({})}>
            {t("ssh.add")}
          </Button>
        )}
      </Section>
      <Section title={t("ssh.history")} description={t("ssh.historyDescription")}>
        <List empty={t("ssh.historyEmpty")}>
          {data.history.map((entry) => (
            <Row key={entry.id}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">
                  {entry.alias}: {entry.command}
                </div>
                <div className="text-xs text-subtle">
                  {ago(entry.at)}
                  {entry.approvedBy && ` · ${t(entry.decision === "deny" ? "ssh.deniedBy" : "ssh.allowedBy", { name: entry.approvedBy })}`}
                  {entry.decision === "turn" && ` · ${t("ssh.decision.turn")}`}
                </div>
              </div>
              <span className={cn("flex-none text-xs", entry.exitCode === 0 ? "text-ok" : "text-subtle")}>
                {entry.exitCode !== null
                  ? t("ssh.exit", { code: entry.exitCode, seconds: ((entry.ms ?? 0) / 1000).toFixed(1) })
                  : t(entry.decision === "deny" ? "ssh.decision.deny" : entry.decision === "timeout" ? "ssh.decision.timeout" : "ssh.decision.failed")}
              </span>
            </Row>
          ))}
        </List>
      </Section>
    </>
  );
}

type Computer = { id: string; name: string; online: boolean };
type Step = "computer" | "server" | "key" | "verify" | "rule";
const STEPS: Step[] = ["computer", "server", "key", "verify", "rule"];

/**
 * Adding a server, in five steps: the computer that keeps its key, the server, the key (a new one,
 * or one from ~/.ssh) with the line to put on the server, the server's own key compared by its
 * fingerprint and a test login, and the rule. `resume`: a server added earlier whose setup stopped.
 */
function AddServer({ projectId, computers, resume, onDone }: { projectId: string; computers: Computer[]; resume?: SshHost; onDone: () => void }) {
  const t = useT();
  const [step, setStep] = useState<Step>(resume ? (resume.keySource === "new" && resume.publicKey && !resume.hostFingerprint ? "key" : "verify") : computers.length === 1 ? "server" : "computer");
  const [runnerId, setRunnerId] = useState(resume?.runnerId ?? computers[0]?.id ?? "");
  const [form, setForm] = useState({ alias: "", host: "", port: "22", user: "" });
  const [keyChoice, setKeyChoice] = useState<"new" | "existing">("new");
  const [existing, setExisting] = useState("");
  const [host, setHost] = useState<SshHost | undefined>(resume);
  const [protectedKey, setProtectedKey] = useState<boolean | null>(null);
  const [hostKeys, setHostKeys] = useState<SshHostKey[] | null>(null);
  const [test, setTest] = useState<SshTestResult | null>(null);
  const [rule, setRule] = useState<SshRule>("ask");

  const localKeys = useQuery({
    queryKey: ["projects", projectId, "ssh", "keys", runnerId],
    queryFn: () => api.listSshKeys(projectId, runnerId),
    enabled: step === "key" && keyChoice === "existing" && !host,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createSshHost(projectId, {
        runnerId,
        alias: form.alias.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        user: form.user.trim(),
        ...(keyChoice === "existing" && { existingKey: existing }),
      }),
    onSuccess: (r) => {
      setHost(r.host);
      setProtectedKey(r.protected);
      // A key of the person's own may already be on the server: straight to its fingerprint.
      if (keyChoice === "existing") setStep("verify");
    },
  });
  const scan = useMutation({ mutationFn: () => api.scanSshHost(projectId, host!.id), onSuccess: setHostKeys });
  const trust = useMutation({
    mutationFn: (key: string) => api.trustSshHost(projectId, host!.id, key),
    onSuccess: (r) => {
      setTest(r);
      setHost(r.host);
    },
  });
  const retest = useMutation({ mutationFn: () => api.testSshHost(projectId, host!.id), onSuccess: setTest });
  const save = useMutation({ mutationFn: () => api.updateSshHost(projectId, host!.id, rule), onSuccess: onDone });

  const serverError = (() => {
    if (!SshAlias.safeParse(form.alias.trim()).success) return form.alias ? t("ssh.aliasInvalid") : null;
    if (form.host && !SshHostName.safeParse(form.host).success) return t("ssh.hostInvalid");
    if (form.user && !SshUser.safeParse(form.user).success) return t("ssh.userInvalid");
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return t("ssh.portInvalid");
    return null;
  })();
  const serverReady = !serverError && !!form.alias && !!form.host && !!form.user;
  const best = hostKeys?.[0];
  const testFailed = test && !test.ok;

  return (
    <div className="space-y-5 rounded-xl border border-line bg-raised p-4">
      <ol className="flex flex-wrap gap-1.5" aria-label={t("ssh.steps")}>
        {STEPS.map((s, i) => {
          const at = STEPS.indexOf(step);
          return (
            <li
              key={s}
              aria-current={s === step ? "step" : undefined}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs",
                s === step ? "bg-fg text-bg" : i < at ? "bg-accent-soft text-accent" : "bg-hover text-subtle",
              )}
            >
              {t(`ssh.step.${s}`)}
            </li>
          );
        })}
      </ol>

      {step === "computer" && (
        <div className="space-y-4">
          <Field label={t("ssh.computer")} hint={t("ssh.computerHint")}>
            <Select value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
              {computers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.online ? "" : ` (${t("ssh.offline")})`}
                </option>
              ))}
            </Select>
          </Field>
          <Actions onCancel={onDone}>
            <Button type="button" disabled={!runnerId} onClick={() => setStep("server")}>
              {t("ssh.next")}
            </Button>
          </Actions>
        </div>
      )}

      {step === "server" && (
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (serverReady) setStep("key");
          }}
        >
          <Field label={t("ssh.alias")} hint={t("ssh.aliasHint")}>
            <Input value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value.toLowerCase() })} placeholder="prod-web" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field label={t("ssh.host")}>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="203.0.113.10" />
            </Field>
            <Field label={t("ssh.port")}>
              <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} inputMode="numeric" />
            </Field>
          </div>
          <Field label={t("ssh.user")} hint={t("ssh.userHint")}>
            <Input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="deploy" />
          </Field>
          {serverError && <Notice>{serverError}</Notice>}
          <Actions onCancel={onDone}>
            <Button type="submit" disabled={!serverReady}>
              {t("ssh.next")}
            </Button>
          </Actions>
        </form>
      )}

      {step === "key" && !host && (
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="sr-only">{t("ssh.step.key")}</legend>
            <Choice checked={keyChoice === "new"} onChange={() => setKeyChoice("new")} title={t("ssh.keyNew")} detail={t("ssh.keyNewDetail")} />
            <Choice checked={keyChoice === "existing"} onChange={() => setKeyChoice("existing")} title={t("ssh.keyExisting")} detail={t("ssh.keyExistingDetail")} />
          </fieldset>
          {keyChoice === "existing" &&
            (localKeys.isPending ? (
              <p className="text-[13px] text-subtle">{t("ssh.loadingKeys")}</p>
            ) : localKeys.error ? (
              <Notice>{errorMessage(localKeys.error, t)}</Notice>
            ) : (
              <Field label={t("ssh.pickKey")}>
                <Select value={existing} onChange={(e) => setExisting(e.target.value)}>
                  <option value="">{localKeys.data.length ? t("ssh.pickKeyPlaceholder") : t("ssh.noKeys")}</option>
                  {localKeys.data.map((k: SshLocalKey) => (
                    <option key={k.path} value={k.path}>
                      {k.name} · {k.type} · {k.fingerprint.slice(0, 20)}…
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          {create.error && <Notice>{errorMessage(create.error, t)}</Notice>}
          <Actions onCancel={onDone} onBack={() => setStep("server")}>
            <Button type="button" disabled={create.isPending || (keyChoice === "existing" && !existing)} onClick={() => create.mutate()}>
              {create.isPending ? t("ssh.making") : keyChoice === "new" ? t("ssh.makeKey") : t("ssh.useKey")}
            </Button>
          </Actions>
        </div>
      )}

      {step === "key" && host?.publicKey && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t("ssh.addLine")}</h3>
          <p className="text-[13px] text-subtle">{t("ssh.addLineHint", { user: host.user, host: host.host })}</p>
          <div className="flex items-start gap-2 rounded-lg border border-line bg-bg p-3">
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{authorizedKeysCommand(host.publicKey)}</code>
            <CopyButton text={authorizedKeysCommand(host.publicKey)} />
          </div>
          {protectedKey === false && <p className="text-xs text-subtle">{t("ssh.noKeychain")}</p>}
          <Actions onCancel={onDone}>
            <Button type="button" onClick={() => setStep("verify")}>
              {t("ssh.added")}
            </Button>
          </Actions>
        </div>
      )}

      {step === "verify" && host && (
        <div className="space-y-4">
          {!hostKeys && !test?.ok && (
            <>
              <p className="text-[13px] text-subtle">{t("ssh.verifyIntro", { host: host.host })}</p>
              {scan.error && <Notice>{errorMessage(scan.error, t)}</Notice>}
              {testFailed && <Notice>{t(`ssh.testError.${test.error ?? "other"}` as "ssh.testError.other")}</Notice>}
              <Actions onCancel={onDone}>
                {host.hostFingerprint && (
                  <GhostButton type="button" disabled={retest.isPending} onClick={() => retest.mutate()}>
                    {retest.isPending ? t("ssh.testing") : t("ssh.test")}
                  </GhostButton>
                )}
                <Button type="button" disabled={scan.isPending} onClick={() => scan.mutate()}>
                  {scan.isPending ? t("ssh.fetching") : t("ssh.fetch")}
                </Button>
              </Actions>
            </>
          )}
          {best && !test?.ok && (
            <>
              <p className="text-[13px] text-subtle">{t("ssh.compare", { host: host.host, type: best.type })}</p>
              <div className="rounded-lg border border-line bg-bg p-4 text-center font-mono text-base break-all">{best.fingerprint}</div>
              <p className="text-xs text-subtle">
                {t("ssh.compareHow")} <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_{hostKeyFile(best.type)}_key.pub</code>
              </p>
              {testFailed && (
                <Notice>
                  {t(`ssh.testError.${test.error ?? "other"}` as "ssh.testError.other")}
                  {test.detail && <span className="mt-1 block font-mono text-xs">{test.detail}</span>}
                </Notice>
              )}
              {trust.error && <Notice>{errorMessage(trust.error, t)}</Notice>}
              <Actions onCancel={onDone} cancelLabel={t("ssh.notSame")}>
                <Button type="button" disabled={trust.isPending} onClick={() => trust.mutate(best.key)}>
                  {trust.isPending ? t("ssh.testing") : testFailed ? t("ssh.tryAgain") : t("ssh.same")}
                </Button>
              </Actions>
            </>
          )}
          {test?.ok && (
            <>
              <Notice tone="ok">{t("ssh.testPassed", { name: host.alias })}</Notice>
              <Actions>
                <Button type="button" onClick={() => setStep("rule")}>
                  {t("ssh.next")}
                </Button>
              </Actions>
            </>
          )}
        </div>
      )}

      {step === "rule" && host && (
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-[13px] text-subtle">{t("ssh.ruleIntro", { name: host.alias })}</legend>
            <Choice checked={rule === "ask"} onChange={() => setRule("ask")} title={t("ssh.rule.ask")} detail={t("ssh.rule.askDetail")} />
            <Choice checked={rule === "off"} onChange={() => setRule("off")} title={t("ssh.rule.off")} detail={t("ssh.rule.offDetail")} />
          </fieldset>
          {save.error && <Notice>{errorMessage(save.error, t)}</Notice>}
          <Actions>
            <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
              {t("ssh.finish")}
            </Button>
          </Actions>
        </div>
      )}
    </div>
  );
}

/** The file a server keeps its key of this type in, as in /etc/ssh/ssh_host_<…>_key.pub. */
function hostKeyFile(type: string): string {
  if (type.startsWith("ecdsa")) return "ecdsa";
  if (type.includes("rsa")) return "rsa";
  return type.replace(/^ssh-/, "");
}

function Choice({ checked, onChange, title, detail }: { checked: boolean; onChange: () => void; title: string; detail: string }) {
  return (
    <label className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", checked ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-1 accent-[var(--color-accent)]" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-[13px] text-subtle">{detail}</span>
      </span>
    </label>
  );
}

function Actions({ children, onCancel, onBack, cancelLabel }: { children: ReactNode; onCancel?: () => void; onBack?: () => void; cancelLabel?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {onCancel && (
        <GhostButton type="button" onClick={onCancel} className="mr-auto">
          {cancelLabel ?? t("ssh.cancel")}
        </GhostButton>
      )}
      {onBack && (
        <GhostButton type="button" onClick={onBack}>
          {t("ssh.back")}
        </GhostButton>
      )}
      {children}
    </div>
  );
}
