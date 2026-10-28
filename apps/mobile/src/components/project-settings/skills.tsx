import { ApiError } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { CreateSkillInput, Skill, SkillChoices } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";
import { BookMarked, ChevronRight, ExternalLink, FileText, GitBranch, Pencil, RefreshCw, Search, Trash2, Upload } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dataUrlBase64 } from "../../lib/files";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Notice, Section } from "../settings-section";
import { Button, errorMessage, Input, Spinner } from "../ui";

/** Where people find skills to add. */
const SKILLS_DIRECTORY = "https://skills.sh";

type T = ReturnType<typeof useT>;

/** The message for a failed skill call: the server's own message, else the first invalid field. */
function skillError(err: unknown, t: T) {
  if (err instanceof ApiError && typeof err.body === "object" && err.body) {
    const body = err.body as { message?: unknown; issues?: { path?: unknown[]; message?: string }[] };
    if (typeof body.message === "string" && body.message) return body.message;
    const issue = body.issues?.[0];
    if (issue?.message) return issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    return t("skills.invalid");
  }
  return errorMessage(err, t("common.error"));
}

function githubUrl(skill: Skill): string | null {
  if (skill.source.kind !== "github") return null;
  const { repo, commit, path } = skill.source;
  return `https://github.com/${repo}/tree/${commit}${path ? `/${path}` : ""}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A SKILL.md without its front matter. */
function bodyOf(md: string) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "").trim();
}

/** A picked file's content, base64-encoded. */
async function readBase64(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
  return dataUrlBase64(dataUrl);
}

const skillsKey = (server: string, projectId: string) => ["projects", server, projectId, "skills"];

/**
 * A project's skills, as the web's Skills tab: the project's own (add from GitHub, write one,
 * upload a SKILL.md; turn on or off, view, edit, update, remove) and the person's own skills with
 * a switch for this project. A whole folder cannot be picked on a phone, so uploads take one SKILL.md.
 */
export function SkillSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  return (
    <>
      <ProjectSkills projectId={projectId} canManage={canManage} />
      <PersonalSkills projectId={projectId} />
    </>
  );
}

function ProjectSkills({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = skillsKey(server, projectId);
  const query = useQuery({ queryKey: key, queryFn: () => api.listSkills(projectId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const [adding, setAdding] = useState<"github" | "write" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const skills = query.data ?? [];
  const opened = skills.find((s) => s.id === open);

  const upload = useMutation({
    mutationFn: async () => {
      const result = await DocumentPicker.getDocumentAsync({ type: ["text/markdown", "text/plain", "*/*"], copyToCacheDirectory: true });
      if (result.canceled || !result.assets[0]) return null;
      return api.createSkill({ kind: "upload", files: [{ path: "SKILL.md", content: await readBase64(result.assets[0].uri) }] }, projectId);
    },
    onSuccess: (skill) => skill && refresh(),
  });

  return (
    <Section title={t("skills.projectTitle")} hint={t("skills.projectDescription")}>
      {query.isPending ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : query.error ? (
        <Notice tone="bad">{skillError(query.error, t)}</Notice>
      ) : skills.length === 0 ? (
        <Text style={styles.sub}>{t("skills.projectEmpty")}</Text>
      ) : (
        skills.map((s) => <SkillRow key={s.id} skill={s} projectId={projectId} onOpen={() => setOpen(s.id)} />)
      )}

      {canManage && (
        <View style={styles.actions}>
          <Button variant="ghost" onPress={() => setAdding("github")}>
            {t("skills.addGithub")}
          </Button>
          <Button variant="ghost" onPress={() => setAdding("write")}>
            {t("skills.addWrite")}
          </Button>
          <Button variant="ghost" pending={upload.isPending} onPress={() => upload.mutate()}>
            {t("mobile.skillUpload")}
          </Button>
        </View>
      )}
      {upload.error && <Notice tone="bad">{skillError(upload.error, t)}</Notice>}
      <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(SKILLS_DIRECTORY)} style={styles.link}>
        <ExternalLink size={13} color={colors.accent} />
        <Text style={[styles.sub, { color: colors.accent }]}>{t("skills.browse")}</Text>
      </Pressable>

      {adding === "github" && <GithubForm projectId={projectId} onDone={() => (setAdding(null), void refresh())} onClose={() => setAdding(null)} />}
      {adding === "write" && <WriteForm projectId={projectId} onDone={() => (setAdding(null), void refresh())} onClose={() => setAdding(null)} />}
      {opened && <SkillDetails skill={opened} projectId={projectId} onClose={() => setOpen(null)} />}
    </Section>
  );
}

function SkillRow({ skill: s, projectId, onOpen }: { skill: Skill; projectId: string; onOpen: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = skillsKey(server, projectId);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateSkill(s.id, { enabled }, projectId),
    onSuccess: (next) => queryClient.setQueryData<Skill[]>(key, (list) => list?.map((x) => (x.id === next.id ? next : x))),
  });
  return (
    <View>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("skills.showDetails")}
          onPress={onOpen}
          style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}
        >
          <View style={styles.icon}>
            <BookMarked size={16} color={colors.muted} />
          </View>
          <View style={{ flex: 1, gap: 2, opacity: s.enabled ? 1 : 0.6 }}>
            <Text style={styles.name} numberOfLines={1}>
              {s.name}
            </Text>
            <Text style={styles.sub} numberOfLines={2}>
              {s.description}
            </Text>
            <SourceLabel skill={s} />
          </View>
          {!s.canEdit && <ChevronRight size={16} color={colors.subtle} />}
        </Pressable>
        {s.canEdit && (
          <Switch
            value={s.enabled}
            disabled={toggle.isPending}
            onValueChange={(on) => toggle.mutate(on)}
            accessibilityLabel={t("skills.enabledLabel", { name: s.name })}
            trackColor={{ false: colors.edge, true: colors.accent }}
            thumbColor={colors.raised}
          />
        )}
      </View>
      {toggle.error && <Notice tone="bad">{skillError(toggle.error, t)}</Notice>}
    </View>
  );
}

function SourceLabel({ skill: s }: { skill: Skill }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  if (s.source.kind === "github") {
    return (
      <View style={styles.meta}>
        <GitBranch size={11} color={colors.subtle} />
        <Text style={[styles.small, { fontFamily: mono }]} numberOfLines={1}>
          {s.source.repo}
          {s.source.path ? `/${s.source.path}` : ""}@{s.source.commit.slice(0, 7)}
        </Text>
      </View>
    );
  }
  return <Text style={styles.small}>{s.source.kind === "write" ? t("skills.source.write") : t("skills.source.upload")}</Text>;
}

/** A full-screen page over the settings, with a title and a close button. */
function Page({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.page, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.pageHead}>
          <Text style={styles.pageTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose}>
            <Text style={[styles.name, { color: colors.accent }]}>{t("common.close")}</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: 14, paddingBottom: 24 }}>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** One skill: its files and SKILL.md, and what can be done with it. */
function SkillDetails({ skill: s, projectId, onClose }: { skill: Skill; projectId: string; onClose: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = skillsKey(server, projectId);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ["skill", server, s.id, s.updatedAt], queryFn: () => api.getSkill(s.id, projectId) });
  const replace = (next: Skill) => queryClient.setQueryData<Skill[]>(key, (list) => list?.map((x) => (x.id === next.id ? next : x)));
  const update = useMutation({
    mutationFn: () => api.updateSkillFromSource(s.id, projectId),
    onSuccess: (res) => {
      replace(res.skill);
      setNotice(res.changed ? t("skills.updated") : t("skills.upToDate"));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSkill(s.id, projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const link = githubUrl(s);
  const confirmRemove = () =>
    Alert.alert(t("skills.deleteConfirm", { name: s.name }), t("skills.deleteBodyProject"), [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: t("skills.delete"), style: "destructive", onPress: () => remove.mutate() },
    ]);

  if (editing) {
    return (
      <WriteForm
        projectId={projectId}
        existing={s}
        onDone={(next) => {
          if (next) replace(next);
          setEditing(false);
        }}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <Page title={s.name} onClose={onClose}>
      <Text style={styles.body}>{s.description}</Text>
      <SourceLabel skill={s} />
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>{t("skills.files", { count: s.files.length, size: formatSize(s.size) })}</Text>
        {s.files.map((f) => (
          <View key={f.path} style={styles.meta}>
            <FileText size={12} color={colors.subtle} />
            <Text style={[styles.small, { flex: 1, fontFamily: mono }]} numberOfLines={1}>
              {f.path}
            </Text>
            <Text style={styles.small}>{formatSize(f.size)}</Text>
          </View>
        ))}
      </View>

      {(s.canEdit || link) && (
        <View style={styles.card}>
          {s.canEdit && s.source.kind === "write" && <Action icon={<Pencil size={16} color={colors.muted} />} label={t("skills.edit")} onPress={() => setEditing(true)} />}
          {s.canEdit && s.source.kind === "github" && (
            <Action
              icon={update.isPending ? <Spinner size={16} /> : <RefreshCw size={16} color={colors.muted} />}
              label={update.isPending ? t("skills.updating") : t("skills.updateFromGithub")}
              onPress={() => {
                setNotice(null);
                update.mutate();
              }}
              disabled={update.isPending}
            />
          )}
          {link && <Action icon={<ExternalLink size={16} color={colors.muted} />} label={t("skills.openGithub")} onPress={() => void WebBrowser.openBrowserAsync(link)} />}
          {s.canEdit && <Action icon={<Trash2 size={16} color={colors.bad} />} label={t("skills.delete")} danger onPress={confirmRemove} disabled={remove.isPending} />}
        </View>
      )}
      {notice && <Text style={[styles.sub, { color: colors.ok }]}>{notice}</Text>}
      {(update.error || remove.error) && <Notice tone="bad">{skillError(update.error ?? remove.error, t)}</Notice>}

      {detail.isPending ? (
        <Spinner />
      ) : detail.error ? (
        <Notice tone="bad">{skillError(detail.error, t)}</Notice>
      ) : (
        <View style={styles.code}>
          <Text selectable style={styles.md}>
            {detail.data.skillMd}
          </Text>
        </View>
      )}
    </Page>
  );
}

function Action({ icon, label, onPress, danger, disabled }: { icon: ReactNode; label: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}>
      {icon}
      <Text style={[styles.body, danger && { color: colors.bad }]}>{label}</Text>
    </Pressable>
  );
}

function GithubForm({ projectId, onDone, onClose }: { projectId: string; onDone: () => void; onClose: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api } = useSession();
  const [source, setSource] = useState("");
  const [choices, setChoices] = useState<SkillChoices["skills"] | null>(null);
  const add = useMutation({
    mutationFn: (input: Extract<CreateSkillInput, { kind: "github" }>) => api.createSkill(input, projectId),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && (err.body as { error?: string } | null)?.error === "choose_skill") {
        setChoices((err.body as SkillChoices).skills);
      }
    },
  });
  const submit = () => {
    if (!source.trim()) return;
    setChoices(null);
    add.mutate({ kind: "github", source });
  };
  const choosing = !!choices && !add.isPending;

  return (
    <Page title={t("skills.addGithub")} onClose={onClose}>
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>{t("skills.githubLabel")}</Text>
        <Input
          value={source}
          onChangeText={(v) => {
            setSource(v);
            setChoices(null);
          }}
          placeholder="anthropics/skills"
          autoFocus
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Text style={styles.sub}>{t("skills.githubHint")}</Text>
      </View>
      {choosing && (
        <View style={{ gap: 6 }}>
          <Text style={styles.sub}>{t("skills.chooseOne", { count: choices.length })}</Text>
          <View style={styles.card}>
            {choices.map((c) => (
              <Pressable
                key={c.path}
                accessibilityRole="button"
                onPress={() => add.mutate({ kind: "github", source, skill: c.name })}
                style={({ pressed }) => [styles.choice, pressed && { backgroundColor: colors.hover }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.name, { fontFamily: mono, fontSize: 14 }]}>{c.name}</Text>
                  {c.description && (
                    <Text style={styles.sub} numberOfLines={2}>
                      {c.description}
                    </Text>
                  )}
                </View>
                <Text style={[styles.sub, { color: colors.accent }]}>{t("skills.add")}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {add.error && !choices && <Notice tone="bad">{skillError(add.error, t)}</Notice>}
      <Button onPress={submit} pending={add.isPending} disabled={!source.trim()}>
        {t("skills.add")}
      </Button>
      <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(SKILLS_DIRECTORY)} style={styles.link}>
        <Search size={13} color={colors.accent} />
        <Text style={[styles.sub, { color: colors.accent }]}>{t("skills.searchDirectory")}</Text>
      </Pressable>
    </Page>
  );
}

function WriteForm({
  projectId,
  existing,
  onDone,
  onClose,
}: {
  projectId: string;
  existing?: Skill;
  onDone: (skill?: Skill) => void;
  onClose: () => void;
}) {
  const t = useT();
  const styles = useStyles();
  const { api, server } = useSession();
  const detail = useQuery({
    queryKey: ["skill", server, existing?.id ?? "", existing?.updatedAt ?? ""],
    queryFn: () => api.getSkill(existing!.id, projectId),
    enabled: !!existing,
  });
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [instructions, setInstructions] = useState<string | null>(existing ? null : "");
  // An edit starts from the stored instructions once they arrive.
  const body = instructions ?? (detail.data ? bodyOf(detail.data.skillMd) : "");
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.updateSkill(existing.id, { description, instructions: body }, projectId)
        : api.createSkill({ kind: "write", name, description, instructions: body }, projectId),
    onSuccess: (skill) => onDone(skill),
  });

  return (
    <Page title={existing ? existing.name : t("skills.addWrite")} onClose={onClose}>
      {!existing && (
        <View style={{ gap: 6 }}>
          <Text style={styles.label}>{t("skills.name")}</Text>
          <Input
            value={name}
            onChangeText={(v) => setName(v.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="weekly-report"
            maxLength={64}
            autoFocus
          />
          <Text style={styles.sub}>{t("skills.nameHint")}</Text>
        </View>
      )}
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>{t("skills.descriptionLabel")}</Text>
        <Input value={description} onChangeText={setDescription} maxLength={1024} autoCapitalize="sentences" autoCorrect multiline />
        <Text style={styles.sub}>{t("skills.descriptionHint")}</Text>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>{t("skills.instructions")}</Text>
        {existing && detail.isPending ? (
          <Spinner />
        ) : (
          <Input
            value={body}
            onChangeText={setInstructions}
            placeholder={t("skills.instructionsPlaceholder")}
            multiline
            textAlignVertical="top"
            style={styles.textarea}
          />
        )}
      </View>
      {save.error && <Notice tone="bad">{skillError(save.error, t)}</Notice>}
      <Button onPress={() => save.mutate()} pending={save.isPending} disabled={(!existing && !name) || !description.trim()}>
        {existing ? t("skills.save") : t("skills.add")}
      </Button>
    </Page>
  );
}

/** The person's own skills, each with a switch for this project, as the web's PersonalInProject. */
function PersonalSkills({ projectId }: { projectId: string }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const key = ["projects", server, projectId, "personal"];
  const query = useQuery({ queryKey: key, queryFn: () => api.getPersonalInProject(projectId) });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setPersonalInProject(projectId, "skills", id, on),
    onMutate: ({ id, on }) =>
      queryClient.setQueryData<Awaited<ReturnType<typeof api.getPersonalInProject>>>(key, (data) =>
        data && { ...data, skills: data.skills.map((s) => (s.id === id ? { ...s, inProject: on } : s)) },
      ),
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const skills = query.data?.skills ?? [];

  return (
    <Section title={t("personalInProject.skillsTitle")} hint={t("personalInProject.skillsDescription")}>
      {query.isPending ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : query.error ? (
        <Notice tone="bad">{errorMessage(query.error, t("common.error"))}</Notice>
      ) : skills.length === 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.sub}>{t("personalInProject.noSkills")}</Text>
          <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(`${server}/settings/skills`)} style={styles.link}>
            <ExternalLink size={13} color={colors.accent} />
            <Text style={[styles.sub, { color: colors.accent }]}>{t("personalInProject.addInSettings")}</Text>
          </Pressable>
        </View>
      ) : (
        skills.map((s) => (
          <View key={s.id} style={styles.row}>
            <View style={styles.icon}>
              <BookMarked size={16} color={colors.muted} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>
                {s.name}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {s.enabled ? s.description : t("personalInProject.offEverywhere")}
              </Text>
            </View>
            <Switch
              value={s.inProject}
              disabled={toggle.isPending}
              onValueChange={(on) => toggle.mutate({ id: s.id, on })}
              accessibilityLabel={t("personalInProject.useHere", { name: s.name })}
              trackColor={{ false: colors.edge, true: colors.accent }}
              thumbColor={colors.raised}
            />
          </View>
        ))
      )}
      {toggle.error && <Notice tone="bad">{errorMessage(toggle.error, t("common.error"))}</Notice>}
    </Section>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { alignItems: "center", paddingVertical: 16 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
    rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
    icon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.hover, alignItems: "center", justifyContent: "center" },
    name: { color: colors.fg, fontSize: 15 },
    body: { color: colors.body, fontSize: 15, lineHeight: 21 },
    label: { color: colors.muted, fontSize: 13, fontWeight: "600" },
    sub: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    small: { color: colors.subtle, fontSize: 12 },
    meta: { flexDirection: "row", alignItems: "center", gap: 4 },
    link: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
    actions: { gap: 8, marginTop: 6 },
    page: { flex: 1, gap: 12, backgroundColor: colors.ground, padding: 16 },
    pageHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    pageTitle: { flex: 1, color: colors.fg, fontSize: 17, fontWeight: "600" },
    card: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.raised, paddingHorizontal: 12, paddingVertical: 4 },
    action: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
    choice: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius.sm, paddingVertical: 10 },
    code: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.raised, padding: 12 },
    md: { color: colors.body, fontFamily: mono, fontSize: 12, lineHeight: 18 },
    textarea: { minHeight: 220, paddingTop: 12, paddingBottom: 12, fontFamily: mono, fontSize: 13 },
  }),
);
