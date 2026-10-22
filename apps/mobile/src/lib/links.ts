import { useT } from "@myrel/i18n/react";
import { resolveFileHref, threadIdFromHref } from "@myrel/protocol";
import { type Href, useRouter } from "expo-router";
import { useCallback } from "react";
import { Alert, Linking } from "react-native";
import { useFileRefContext } from "./file-refs";

/**
 * Links in messages: web pages (artifacts above all) open in the in-app
 * viewer so the user stays in the conversation; anything else (mailto:,
 * tel:) goes to the OS. A thread link ([Title](#thr_…)) opens that thread, and
 * a file's path opens the file: a project file, or one in the project's folder
 * on this person's computer (looked up in `threadId`'s worktree first).
 */
export function useOpenLink(projectId: string, threadId?: string) {
  const t = useT();
  const router = useRouter();
  const files = useFileRefContext();
  return useCallback(
    (href: string) => {
      const linkedThread = threadIdFromHref(href);
      const file = resolveFileHref(href, files);
      if (linkedThread) router.push(`/projects/${projectId}/threads/${linkedThread}` as Href);
      else if (file?.kind === "elsewhere") Alert.alert(t("files.onOtherComputer"), t("files.onOtherComputerBody"));
      else if (file) {
        const local = file.kind === "local" ? `&local=1${threadId ? `&thread=${encodeURIComponent(threadId)}` : ""}` : "";
        router.push(`/projects/${projectId}/file?path=${encodeURIComponent(file.path)}${local}` as Href);
      } else if (/^https?:\/\//i.test(href)) router.push({ pathname: "/artifact", params: { url: href } });
      else void Linking.openURL(href).catch(() => {});
    },
    [router, projectId, threadId, files, t],
  );
}

/** Opens one of the project's artifacts in the in-app viewer; `version` pins an older one. */
export function useOpenArtifact(projectId: string) {
  const router = useRouter();
  return useCallback(
    (artifactId: string, version?: number) =>
      router.push({
        pathname: "/artifact",
        params: { projectId, artifactId, ...(version ? { version: String(version) } : {}) },
      }),
    [router, projectId],
  );
}
