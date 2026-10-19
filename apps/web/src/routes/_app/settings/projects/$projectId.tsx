import type { InviteRole, ProjectRole, ProviderId, TaskTarget } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { GithubRepos } from "../../../../components/github-repos";
import { Badge, Field, List, Notice, Row, Section, Select } from "../../../../components/settings";
import {
  api,
  keysQuery,
  membersQuery,
  projectInvitesQuery,
  projectQuery,
  projectSettingsQuery,
  projectsQuery,
  providersQuery,
} from "../../../../lib/api";
import { Button, errorMessage, GhostButton, IconButton, initials, Input } from "../../../../lib/ui";

export const Route = createFileRoute("/_app/settings/projects/$projectId")({
  // `github` is the result of a GitHub connect round trip (see components/github-repos.tsx).
  validateSearch: (search: Record<string, unknown>): { github?: string } =>
    typeof search.github === "string" ? { github: search.github } : {},
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectQuery(params.projectId)),
      context.queryClient.ensureQueryData(projectSettingsQuery(params.projectId)),
    ]),
  component: ProjectSettingsPage,
});

const ROLE_LABELS: Record<ProjectRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function ProjectSettingsPage() {
  const { projectId } = Route.useParams();
  const { github } = Route.useSearch();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const canManage = project.role === "owner" || project.role === "admin";

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <p className="mt-1 text-[13px] text-subtle">
          You are {ROLE_LABELS[project.role].toLowerCase()} of this project.{" "}
          <Link to="/projects/$projectId" params={{ projectId }} className="text-accent hover:underline">
            Open project
          </Link>
        </p>
      </div>
      <GeneralAndModel projectId={projectId} canManage={canManage} />
      <GithubRepos projectId={projectId} canManage={canManage} githubResult={github} />
      <Members projectId={projectId} myRole={project.role} />
      {canManage && <Invites projectId={projectId} />}
    </>
  );
}

function GeneralAndModel({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(projectSettingsQuery(projectId));
  const { data: providers } = useQuery(providersQuery);
  const { data: keys = [] } = useQuery(keysQuery);

  const [name, setName] = useState(settings.name);
  const [provider, setProvider] = useState<ProviderId | "">(settings.provider ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [keyId, setKeyId] = useState(settings.keyId ?? "");
  const [taskTarget, setTaskTarget] = useState<TaskTarget>(settings.taskTarget);
  useEffect(() => {
    setName(settings.name);
    setProvider(settings.provider ?? "");
    setModel(settings.model ?? "");
    setKeyId(settings.keyId ?? "");
    setTaskTarget(settings.taskTarget);
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProjectSettings(projectId, {
        name: name.trim(),
        provider: provider || null,
        model: model.trim() || null,
        keyId: keyId || null,
        taskTarget,
      }),
    onSuccess: (s) => {
      queryClient.setQueryData(projectSettingsQuery(projectId).queryKey, s);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQuery(projectId).queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey, exact: true }),
      ]);
    },
  });

  const effectiveProvider = provider || providers?.serverDefault;
  const providerInfo = providers?.providers.find((p) => p.id === effectiveProvider);
  // A key you cannot see (someone else's) stays selected but is shown as such.
  const usableKeys = keys.filter((k) => k.provider === effectiveProvider);
  const foreignKey = keyId && !keys.some((k) => k.id === keyId);
  const noKey = !keyId && providerInfo && !providerInfo.serverKey;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) save.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-10">
      <Section title="General">
        <Field label="Project name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={!canManage} />
        </Field>
      </Section>

      <Section
        title="Model"
        description="Which model the coordinator and thread agents use in this project. Leave empty to use the server default."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
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
                Server default
                {providers ? ` (${providers.providers.find((p) => p.id === providers.serverDefault)?.name})` : ""}
              </option>
              {providers?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" hint={providerInfo ? `Default: ${providerInfo.defaultModel}` : undefined}>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={providerInfo?.defaultModel ?? "Default"}
              spellCheck={false}
              disabled={!canManage}
            />
          </Field>
        </div>
        <Field
          label="Key"
          hint={
            <>
              Add your own keys under{" "}
              <Link to="/settings/keys" className="text-accent hover:underline">
                Model keys
              </Link>
              . Everyone in the project uses the key you pick here.
            </>
          }
        >
          <Select value={keyId} onChange={(e) => setKeyId(e.target.value)} disabled={!canManage}>
            <option value="">{providerInfo?.serverKey ? "Server key" : "No key"}</option>
            {foreignKey && <option value={keyId}>Another member's key</option>}
            {usableKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} {k.hint} {k.scope === "instance" ? "(shared)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        {noKey && (
          <Notice>
            The server has no {providerInfo.name} key, so agents cannot answer in this project until you pick one.
          </Notice>
        )}
      </Section>

      <Section
        title="Tasks"
        description="Where thread agents run code: on a computer with the project's local folder, using its own coding CLI, or in a sandbox in the cloud."
      >
        <Field label="Run tasks">
          <Select value={taskTarget} onChange={(e) => setTaskTarget(e.target.value as TaskTarget)} disabled={!canManage}>
            <option value="auto">Automatic: on the computer when it is online, otherwise in the cloud</option>
            <option value="local">Always on the computer</option>
            <option value="cloud">Always in the cloud</option>
          </Select>
        </Field>
      </Section>

      {canManage && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending || !name.trim()}>
            Save changes
          </Button>
          {save.isSuccess && !save.isPending && <Notice tone="ok">Saved.</Notice>}
          {save.error && <Notice>{errorMessage(save.error)}</Notice>}
        </div>
      )}
    </form>
  );
}

function Members({ projectId, myRole }: { projectId: string; myRole: ProjectRole }) {
  const { user } = Route.useRouteContext();
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
    <Section title="Members" description="Owners and admins manage members, invitations and settings.">
      <List empty="No members.">
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
                  {isMe && <Badge>You</Badge>}
                </div>
                {m.email && <div className="truncate text-xs text-subtle">{m.email}</div>}
              </div>
              {editable ? (
                <Select
                  className="w-28"
                  aria-label={`Role of ${m.name}`}
                  value={m.role}
                  disabled={setRole.isPending}
                  onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as ProjectRole })}
                >
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-[13px] text-subtle">{ROLE_LABELS[m.role]}</span>
              )}
              {(editable || isMe) && (
                <IconButton
                  type="button"
                  aria-label={isMe ? "Leave project" : `Remove ${m.name}`}
                  title={isMe ? "Leave project" : "Remove"}
                  disabled={remove.isPending}
                  onClick={() => {
                    const question = isMe ? "Leave this project?" : `Remove ${m.name} from the project?`;
                    if (confirm(question)) remove.mutate(m.id);
                  }}
                >
                  <X size={15} />
                </IconButton>
              )}
            </Row>
          );
        })}
      </List>
      {(setRole.error || remove.error) && <Notice>{errorMessage(setRole.error ?? remove.error)}</Notice>}
    </Section>
  );
}

function Invites({ projectId }: { projectId: string }) {
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
      title="Invite people"
      description="They see the invitation under Settings → Invitations after signing in with this email, and can create an account with it even when sign-ups are closed."
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
        <Select className="sm:w-32" value={role} onChange={(e) => setRole(e.target.value as InviteRole)} aria-label="Role">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </Select>
        <Button type="submit" disabled={invite.isPending || !email.trim()}>
          Invite
        </Button>
      </form>
      {invite.error && <Notice>{errorMessage(invite.error)}</Notice>}
      {invites.length > 0 && (
        <List empty="">
          {invites.map((i) => (
            <Row key={i.id}>
              <div className="min-w-0 flex-1">
                <div className="truncate">{i.email}</div>
                <div className="text-xs text-subtle">
                  Pending · {ROLE_LABELS[i.role].toLowerCase()} · invited by {i.invitedBy}
                </div>
              </div>
              <GhostButton type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>
                Revoke
              </GhostButton>
            </Row>
          ))}
        </List>
      )}
    </Section>
  );
}
