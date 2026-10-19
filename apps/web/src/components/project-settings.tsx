import { useT } from "@altair/i18n/react";
import type { InviteRole, ProjectRole, ProviderId } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { GithubRepos } from "./github-repos";
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

export const roleKey = (role: ProjectRole) => `role.${role}` as const;

/**
 * Everything about one project: general and model, GitHub, members and
 * invites. Drawn on the settings page and in the project's settings dialog.
 */
export function ProjectSettings({
  projectId,
  github,
  header = true,
}: {
  projectId: string;
  github?: string;
  /** The project's name and your role; the dialog shows these in its own header. */
  header?: boolean;
}) {
  const t = useT();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const canManage = project.role === "owner" || project.role === "admin";

  return (
    <>
      {header && (
        <div>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <p className="mt-1 text-[13px] text-subtle">
            {t("projectSettings.youAre", { role: t(roleKey(project.role)) })}{" "}
            <Link to="/projects/$projectId" params={{ projectId }} className="text-accent hover:underline">
              {t("projectSettings.open")}
            </Link>
          </p>
        </div>
      )}
      <GeneralAndModel projectId={projectId} canManage={canManage} />
      <GithubRepos projectId={projectId} canManage={canManage} githubResult={github} />
      <Members projectId={projectId} myRole={project.role} />
      {canManage && <Invites projectId={projectId} />}
    </>
  );
}

function GeneralAndModel({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(projectSettingsQuery(projectId));
  const { data: providers } = useQuery(providersQuery);
  const { data: keys = [] } = useQuery(keysQuery);

  const [name, setName] = useState(settings.name);
  const [provider, setProvider] = useState<ProviderId | "">(settings.provider ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [keyId, setKeyId] = useState(settings.keyId ?? "");
  useEffect(() => {
    setName(settings.name);
    setProvider(settings.provider ?? "");
    setModel(settings.model ?? "");
    setKeyId(settings.keyId ?? "");
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProjectSettings(projectId, {
        name: name.trim(),
        provider: provider || null,
        model: model.trim() || null,
        keyId: keyId || null,
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
      <Section title={t("projectSettings.general")}>
        <Field label={t("projectSettings.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={!canManage} />
        </Field>
      </Section>

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

      {canManage && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending || !name.trim()}>
            {t("settings.saveChanges")}
          </Button>
          {save.isSuccess && !save.isPending && <Notice tone="ok">{t("settings.saved")}</Notice>}
          {save.error && <Notice>{errorMessage(save.error, t)}</Notice>}
        </div>
      )}
    </form>
  );
}

function Members({ projectId, myRole }: { projectId: string; myRole: ProjectRole }) {
  const t = useT();
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
                  onClick={() => {
                    const question = isMe ? t("members.leaveConfirm") : t("members.removeConfirm", { name: m.name });
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
