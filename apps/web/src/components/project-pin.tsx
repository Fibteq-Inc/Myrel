import { withProjectPinned } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Project } from "@myrel/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pin, PinOff } from "lucide-react";
import { api, projectsQuery } from "../lib/api";
import { cn } from "../lib/ui";

/** Pins or unpins a project for the signed-in person, moving it in every cached project list at once. */
export function usePinProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api.pinProject(id, pinned),
    onMutate: async ({ id, pinned }) => {
      await queryClient.cancelQueries({ queryKey: projectsQuery.queryKey, exact: true });
      const before = queryClient.getQueryData<Project[]>(projectsQuery.queryKey);
      if (before) queryClient.setQueryData(projectsQuery.queryKey, withProjectPinned(before, id, pinned));
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) queryClient.setQueryData(projectsQuery.queryKey, context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey, exact: true }),
  });
}

/**
 * The pin toggle beside a project in a list. Always shown while pinned; otherwise it appears when its
 * row (a `group`) is hovered or focused, so unpinned lists stay quiet.
 */
export function PinButton({ project, className = "" }: { project: Project; className?: string }) {
  const t = useT();
  const pin = usePinProject();
  const pinned = !!project.pinned;
  const label = pinned ? t("projects.unpin") : t("projects.pin");
  const Icon = pinned ? PinOff : Pin;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pin.mutate({ id: project.id, pinned: !pinned });
      }}
      className={cn(
        "group/pin inline-flex size-7 flex-none items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-fg focus-visible:opacity-100",
        pinned ? "text-link" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
        className,
      )}
    >
      {/* A pinned project shows a pin; hovering its button previews the unpin. */}
      {pinned ? (
        <>
          <Pin size={14} className="fill-current group-hover/pin:hidden" aria-hidden="true" />
          <Icon size={14} className="hidden group-hover/pin:block" aria-hidden="true" />
        </>
      ) : (
        <Icon size={14} aria-hidden="true" />
      )}
    </button>
  );
}
