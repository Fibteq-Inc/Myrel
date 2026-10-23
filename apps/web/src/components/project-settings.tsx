import { useT } from "@myrel/i18n/react";
import type { InviteRole, ProjectRole, ProviderId, TaskTarget, UpdateProjectSettingsInput } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { BookMarked, Folder, FolderGit2, Plug, Settings2, Sparkles, Users, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { Connectors } from "./connectors";
import { PersonalInProject } from "./personal-in-project";
import { Skills } from "./skills";
import { GithubRepos } from "./github-repos";
import { ProjectFolders } from "./project-folders";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Badge, Field, List, Notice, Row, Section, Select } from "./settings";
import {
  api,
  keysQuery,
  membersQuery,
  projectInvitesQuery,
  projectQuery,
  projectSettingsQuery,
  projectsQuery,
  providersQuery,
} from "../lib/api";
import { Button, errorMessage, GhostButton, IconButton, initials, Input } from "../lib/ui";
import { useConfirm } from "./ui/confirm";

export const roleKey = (role: ProjectRole) => `role.${role}` as const;

export type ProjectSettingsTab = "general" | "model" | "folders" | "github" | "connectors" | "skills" | "members";

/**
 * Everything about one project, split into tabs: general (name, where tasks run, delete),
 * model and key, GitHub, connectors, skills, members and invites. Drawn on the settings page
 * (tabs across the top) and in the project's settings dialog (tabs down the side).
 * A new group of settings gets its own entry in `tabs` below.
 */
export function ProjectSettings({
  projectId,
  github,
  connectorId,
  connectorResult,
  layout = "page",
  initialTab = "general",
}: {
  projectId: string;
  github?: string;
  /** `?connector=` and `?result=` after a connector's OAuth sign-in. */
  connectorId?: string;
  connectorResult?: string;
  /** "dialog" puts the tabs in a side column and leaves the name and role to the dialog's header. */
  layout?: "page" | "dialog";
  /** The tab to open on when no sign-in round trip picks one. */
  initialTab?: ProjectSettingsTab;
}) {
  const t = useT();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const canManage = project.role === "owner" || project.role === "admin";
  // Coming back from a GitHub or connector sign-in opens the tab that started it.
  const [tab, setTab] = useState<ProjectSettingsTab>(
    github ? "github" : connectorId || connectorResult ? "connectors" : initialTab,
  );

  const tabs: { id: ProjectSettingsTab; label: string; icon: ReactNode }[] = [
    { id: "general", label: t("projectSettings.tab.general"), icon: <Settings2 size={15} /> },
    { id: "model", label: t("projectSettings.tab.model"), icon: <Sparkles size={15} /> },
    { id: "folders", label: t("projectSettings.tab.folders"), icon: <Folder size={15} /> },
    { id: "github", label: t("projectSettings.tab.github"), icon: <FolderGit2 size={15} /> },
    { id: "connectors", label: t("projectSettings.tab.connectors"), icon: <Plug size={15} /> },
    { id: "skills", label: t("settings.skills"), icon: <BookMarked size={15} /> },
    { id: "members", label: t("projectSettings.tab.members"), icon: <Users size={15} /> },
  ];

  const panel = (
    <div role="tabpanel" id={`project-settings-${tab}`} aria-labelledby={`project-settings-tab-${tab}`} className="space-y-10">
      {tab === "general" && (
        <>
          <GeneralForm projectId={projectId} canManage={canManage} />
          {project.role === "owner" && <DangerZone projectId={projectId} name={project.name} />}
        </>
      )}
      {tab === "model" && <ModelForm projectId={projectId} canManage={canManage} />}
      {tab === "folders" && <ProjectFolders project={project} canManage={canManage} />}
      {tab === "github" && <GithubRepos projectId={projectId} canManage={canManage} githubResult={github} />}
      {tab === "connectors" && (
        <>
          <Connectors projectId={projectId} canManage={canManage} result={connectorResult} connectorId={connectorId} />
          <PersonalInProject projectId={projectId} kind="connectors" />
        </>
      )}
      {tab === "skills" && (
        <>
          <Skills projectId={projectId} canManage={canManage} />
          <PersonalInProject projectId={projectId} kind="skills" />
        </>
      )}
      {tab === "members" && (
        <>
          <Members projectId={projectId} myRole={project.role} />
          {canManage && <Invites projectId={projectId} />}
        </>
      )}
    </div>
  );

  if (layout === "dialog") {
    return (
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <TabList tabs={tabs} tab={tab} onChange={setTab} vertical />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">{panel}</div>
      </div>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <p className="mt-1 text-[13px] text-subtle">
          {t("projectSettings.youAre", { role: t(roleKey(project.role)) })}{" "}
          <Link to="/projects/$projectId" params={{ projectId }} className="text-accent hover:underline">
            {t("projectSettings.open")}
          </Link>
        </p>
      </div>
      <div className="!mt-5 space-y-8">
        <TabList tabs={tabs} tab={tab} onChange={setTab} />
        {panel}
      </div>
    </>
  );
}

/** The project settings' tabs: a side column in the dialog (a strip on phones), a strip on the page. */
function TabList({
  tabs,
  tab,
  onChange,
  vertical = false,
}: {
  tabs: { id: ProjectSettingsTab; label: string; icon: ReactNode }[];
  tab: ProjectSettingsTab;
  onChange: (tab: ProjectSettingsTab) => void;
  vertical?: boolean;
}) {
  const t = useT();
  // Arrow keys move between tabs, as in any tab list.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys = vertical ? ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] : ["ArrowLeft", "ArrowRight"];
    if (!keys.includes(e.key) && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = tabs.findIndex((x) => x.id === tab);
    const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (back ? -1 : 1) + tabs.length) % tabs.length;
    onChange(tabs[next]!.id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={t("projectSettings.sections")}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={onKeyDown}
      className={
        vertical
          ? "flex flex-none gap-1 overflow-x-auto border-b border-line px-3 py-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-2 sm:py-4"
          : "-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 pb-2"
      }
    >
      {tabs.map((x) => {
        const active = x.id === tab;
        return (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`project-settings-tab-${x.id}`}
            aria-selected={active}
            aria-controls={`project-settings-${x.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(x.id)}
            className={`flex flex-none items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] ${
              active ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            <span className={active ? "text-fg" : "text-subtle"}>{x.icon}</span>
            {x.label}
          </button>
        );
      })}
    </div>
  );
}

/** Saves one tab's fields of the project's settings; renaming also refreshes the project lists. */
function useSaveSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectSettingsInput) => api.updateProjectSettings(projectId, input),
    onSuccess: (s) => {
      queryClient.setQueryData(projectSettingsQuery(projectId).queryKey, s);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQuery(projectId).queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey, exact: true }),
      ]);
    },
  });
}

function GeneralForm({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const { data: settings } = useSuspenseQuery(projectSettingsQuery(projectId));
  const [name, setName] = useState(settings.name);
  const [taskTarget, setTaskTarget] = useState<TaskTarget>(settings.taskTarget);
  useEffect(() => {
    setName(settings.name);
    setTaskTarget(settings.taskTarget);
  }, [settings]);
  const save = useSaveSettings(projectId);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) save.mutate({ name: name.trim(), taskTarget });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-10">
      <Section title={t("projectSettings.general")}>
        <Field label={t("projectSettings.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={!canManage} />
        </Field>
      </Section>

      <Section title={t("projectSettings.tasks")} description={t("projectSettings.tasksDescription")}>
        <Field label={t("projectSettings.runTasks")}>
          <Select value={taskTarget} onChange={(e) => setTaskTarget(e.target.value as TaskTarget)} disabled={!canManage}>
            <option value="auto">{t("projectSettings.taskTarget.auto")}</option>
            <option value="local">{t("projectSettings.taskTarget.local")}</option>
            <option value="cloud">{t("projectSettings.taskTarget.cloud")}</option>
          </Select>
        </Field>
      </Section>

      {canManage && <SaveBar save={save} disabled={!name.trim()} />}
    </form>
  );
}

function ModelForm({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const { data: settings } = useSuspenseQuery(projectSettingsQuery(projectId));
  const { data: providers } = useQuery(providersQuery);
  const { data: keys = [] } = useQuery(keysQuery);

  const [provider, setProvider] = useState<ProviderId | "">(settings.provider ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [keyId, setKeyId] = useState(settings.keyId ?? "");
  useEffect(() => {
    setProvider(settings.provider ?? "");
    setModel(settings.model ?? "");
    setKeyId(settings.keyId ?? "");
  }, [settings]);
  const save = useSaveSettings(projectId);

  const effectiveProvider = provider || providers?.serverDefault;
  const providerInfo = providers?.providers.find((p) => p.id === effectiveProvider);
  // A key you cannot see (someone else's) stays selected but is shown as such.
  const usableKeys = keys.filter((k) => k.provider === effectiveProvider);
  const foreignKey = keyId && !keys.some((k) => k.id === keyId);
  const noKey = !keyId && providerInfo && !providerInfo.serverKey;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ provider: provider || null, model: model.trim() || null, keyId: keyId || null });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-10">
      <Section
        title={t("projectSettings.model")}
        description={t("projectSettings.modelDescription")}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("projectSettings.provider")}>
            <Select
              value={provider}
              disabled={!canManage}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId | "");
                setKeyId("");
                setModel("");
              }}
            >
              <option value="">
                {providers
                  ? t("projectSettings.serverDefaultNamed", {
                      name: providers.providers.find((p) => p.id === providers.serverDefault)?.name ?? "",
                    })
                  : t("projectSettings.serverDefault")}
              </option>
              {providers?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t("projectSettings.model")}
            hint={providerInfo ? t("projectSettings.modelHint", { model: providerInfo.defaultModel }) : undefined}
          >
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={providerInfo?.defaultModel ?? t("projectSettings.modelPlaceholder")}
              spellCheck={false}
              disabled={!canManage}
            />
          </Field>
        </div>
        <Field
          label={t("projectSettings.key")}
          hint={
            <>
              {t("projectSettings.keyHintBefore")}{" "}
              <Link to="/settings/keys" className="text-accent hover:underline">
                {t("settings.keys")}
              </Link>
              {t("projectSettings.keyHintAfter")}
            </>
          }
        >
          <Select value={keyId} onChange={(e) => setKeyId(e.target.value)} disabled={!canManage}>
            <option value="">{providerInfo?.serverKey ? t("projectSettings.serverKey") : t("projectSettings.noKey")}</option>
            {foreignKey && <option value={keyId}>{t("projectSettings.foreignKey")}</option>}
            {usableKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} {k.hint} {k.scope === "instance" ? t("projectSettings.shared") : ""}
              </option>
            ))}
          </Select>
        </Field>
        {noKey && (
          <Notice>
            {t("projectSettings.missingKey", { provider: providerInfo.name })}
          </Notice>
        )}
      </Section>

      {canManage && <SaveBar save={save} />}
    </form>
  );
}

function SaveBar({ save, disabled }: { save: ReturnType<typeof useSaveSettings>; disabled?: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={save.isPending || disabled}>
        {t("settings.saveChanges")}
      </Button>
      {save.isSuccess && !save.isPending && <Notice tone="ok">{t("settings.saved")}</Notice>}
      {save.error && <Notice>{errorMessage(save.error, t)}</Notice>}
    </div>
  );
}

function Members({ projectId, myRole }: { projectId: string; myRole: ProjectRole }) {
  const t = useT();
  const confirm = useConfirm();
  const { user } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: members = [] } = useQuery(membersQuery(projectId));
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQuery(projectId).queryKey });

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => api.updateMemberRole(projectId, userId, role),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(projectId, userId),
    onSuccess: async (_, userId) => {
      if (userId !== user.id) return refresh();
      await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      await navigate({ to: "/" });
    },
  });

  const canManage = myRole === "owner" || myRole === "admin";
  const roleOptions: ProjectRole[] = myRole === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];

  return (
    <Section title={t("members.title")} description={t("members.description")}>
      <List empty={t("members.empty")}>
        {members.map((m) => {
          const isMe = m.id === user.id;
          const editable = canManage && !isMe && (m.role !== "owner" || myRole === "owner");
          return (
            <Row key={m.id}>
              <span
                aria-hidden="true"
                className="flex size-8 flex-none items-center justify-center rounded-full bg-hover text-xs font-semibold text-muted"
              >
                {initials(m.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{m.name}</span>
                  {isMe && <Badge>{t("members.you")}</Badge>}
                </div>
                {m.email && <div className="truncate text-xs text-subtle">{m.email}</div>}
              </div>
              {editable ? (
                <Select
                  className="w-28"
                  aria-label={t("members.roleOf", { name: m.name })}
                  value={m.role}
                  disabled={setRole.isPending}
                  onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as ProjectRole })}
                >
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {t(roleKey(r))}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-[13px] text-subtle">{t(roleKey(m.role))}</span>
              )}
              {(editable || isMe) && (
                <IconButton
                  type="button"
                  aria-label={isMe ? t("members.leave") : t("members.removeLabel", { name: m.name })}
                  title={isMe ? t("members.leave") : t("members.remove")}
                  disabled={remove.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: isMe ? t("members.leaveConfirm") : t("members.removeConfirm", { name: m.name }),
                      action: isMe ? t("members.leave") : t("members.remove"),
                      danger: true,
                    });
                    if (ok) remove.mutate(m.id);
                  }}
                >
                  <X size={15} />
                </IconButton>
              )}
            </Row>
          );
        })}
      </List>
      {(setRole.error || remove.error) && <Notice>{errorMessage(setRole.error ?? remove.error, t)}</Notice>}
    </Section>
  );
}

function Invites({ projectId }: { projectId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: invites = [] } = useQuery(projectInvitesQuery(projectId));
  const refresh = () => queryClient.invalidateQueries({ queryKey: projectInvitesQuery(projectId).queryKey });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const invite = useMutation({
    mutationFn: () => api.invite(projectId, { email: email.trim(), role }),
    onSuccess: () => {
      setEmail("");
      return refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvite(projectId, id), onSuccess: refresh });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    invite.mutate();
  }

  return (
    <Section
      title={t("projectInvites.title")}
      description={t("projectInvites.description")}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          required
          className="flex-1"
        />
        <Select className="sm:w-32" value={role} onChange={(e) => setRole(e.target.value as InviteRole)} aria-label={t("projectInvites.role")}>
          <option value="member">{t("role.member")}</option>
          <option value="admin">{t("role.admin")}</option>
        </Select>
        <Button type="submit" disabled={invite.isPending || !email.trim()}>
          {t("projectInvites.invite")}
        </Button>
      </form>
      {invite.error && <Notice>{errorMessage(invite.error, t)}</Notice>}
      {invites.length > 0 && (
        <List empty="">
          {invites.map((i) => (
            <Row key={i.id}>
              <div className="min-w-0 flex-1">
                <div className="truncate">{i.email}</div>
                <div className="text-xs text-subtle">
                  {t("projectInvites.pending", { role: t(roleKey(i.role)), name: i.invitedBy })}
                </div>
              </div>
              <GhostButton type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>
                {t("projectInvites.revoke")}
              </GhostButton>
            </Row>
          ))}
        </List>
      )}
    </Section>
  );
}

/** Owners only: deletes the project for everyone after typing its name. */
function DangerZone({ projectId, name }: { projectId: string; name: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: members = [] } = useQuery(membersQuery(projectId));
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({ queryKey: projectQuery(projectId).queryKey });
      await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      await navigate({ to: "/" });
    },
  });

  return (
    <Section title={t("deleteProject.title")}>
      <div className="flex flex-col gap-3 rounded-xl border border-bad/40 bg-bad/5 px-4 py-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-[13px] text-muted">{t("deleteProject.description")}</p>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex h-8 flex-none items-center justify-center rounded-lg border border-bad/50 px-3 text-[13px] font-medium text-bad hover:bg-bad/10"
        >
          {t("deleteProject.button")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("deleteProject.confirmTitle", { name })}
          body={t("deleteProject.confirmBody", { count: Math.max(1, members.length) })}
          confirmLabel={t("deleteProject.confirm")}
          busyLabel={t("deleteProject.deleting")}
          typeToConfirm={name}
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error, t) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => {
            setConfirming(false);
            remove.reset();
          }}
        />
      )}
    </Section>
  );
}
