import { useT } from "@myrel/i18n/react";
import type { Notification, NotificationKind } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck, CircleAlert, CircleCheck, CircleHelp, CirclePause, MessageSquareText } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, notificationConfigQuery, notificationSettingsQuery, notificationsQuery } from "../lib/api";
import { useFormat } from "../lib/format";
import { currentPushSubscription, disableWebPush, enableWebPush, webPushSupported } from "../lib/push";
import { errorMessage } from "../lib/ui";
import { Popover } from "./popover";
import { Switch } from "./ui/controls";

const ICONS: Record<NotificationKind, ReactNode> = {
  done: <CircleCheck size={16} className="text-ok" />,
  ready: <MessageSquareText size={16} className="text-accent" />,
  decision: <CircleHelp size={16} className="text-warn" />,
  blocked: <CirclePause size={16} className="text-warn" />,
  failed: <CircleAlert size={16} className="text-bad" />,
};

/** The bell with the unread count, opening the notification list and delivery settings. */
/** side "right" opens beside an icon rail; "below" drops under a header button. */
export function NotificationBell({ side = "right" }: { side?: "right" | "below" }) {
  const t = useT();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery(notificationsQuery);
  const unread = data?.unread ?? 0;

  useEffect(() => {
    document.title = unread ? `(${unread}) Myrel` : "Myrel";
  }, [unread]);

  const markRead = useMutation({
    mutationFn: (ids: string[] | "all") => api.markNotificationsRead(ids),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey, exact: true }),
  });

  async function openNotification(n: Notification) {
    setOpen(false);
    if (!n.readAt) markRead.mutate([n.id]);
    const [, , projectId, , threadId] = new URL(n.url, location.origin).pathname.split("/");
    if (!projectId) return;
    await (threadId
      ? navigate({ to: "/projects/$projectId/threads/$threadId", params: { projectId, threadId } })
      : navigate({ to: "/projects/$projectId", params: { projectId } }));
  }

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? t("notifications.unreadLabel", { count: unread }) : t("notifications.title")}
        aria-expanded={open}
        className="relative flex size-11 items-center justify-center rounded-[10px] text-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <Bell size={20} strokeWidth={1.8} />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-ground">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement={side}
        className={`flex max-h-[min(560px,80vh)] w-[360px] max-w-[calc(100vw-24px)] flex-col`}
      >
        <div className="flex items-center border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold">{t("notifications.title")}</h2>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markRead.mutate("all")}
              className="ml-auto flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
            >
              <CheckCheck size={13} />
              {t("notifications.markAllRead")}
            </button>
          )}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {data?.notifications.length ? (
            data.notifications.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => openNotification(n)}
                  className="flex w-full gap-3 px-4 py-2.5 text-left hover:bg-hover"
                >
                  <span className="mt-0.5 flex-none" aria-hidden="true">
                    {ICONS[n.kind]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate text-[13px] ${n.readAt ? "text-muted" : "font-medium text-fg"}`}>
                        {n.title}
                      </span>
                      <span className="ml-auto flex-none text-[11px] text-subtle">{format.relative(n.createdAt)}</span>
                    </span>
                    <span className="block text-xs text-subtle">{t(`notifications.${n.kind}`)}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>}
                  </span>
                  {!n.readAt && <span aria-label={t("notifications.unread")} className="mt-1.5 size-2 flex-none rounded-full bg-accent" />}
                </button>
              </li>
            ))
          ) : (
            <li className="px-4 py-8 text-center text-[13px] text-subtle">
              {t("notifications.empty")}
            </li>
          )}
        </ul>
        <DeliverySettings />
      </Popover>
    </div>
  );
}

function DeliverySettings() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: config } = useQuery(notificationConfigQuery);
  const { data: settings } = useQuery(notificationSettingsQuery);
  const [browserOn, setBrowserOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void currentPushSubscription().then((s) => setBrowserOn(Boolean(s)));
  }, []);

  const save = useMutation({
    mutationFn: (patch: { email?: boolean; push?: boolean }) => api.updateNotificationSettings(patch),
    onSuccess: (next) => queryClient.setQueryData(notificationSettingsQuery.queryKey, next),
  });

  async function toggleBrowser(on: boolean) {
    setError(null);
    try {
      if (on) {
        await enableWebPush(config!.webPushKey!);
        if (settings && !settings.push) await save.mutateAsync({ push: true });
      } else await disableWebPush();
      setBrowserOn(on);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  const canPush = webPushSupported && !!config?.webPushKey;
  if (!config || !settings || (!config.email && !canPush)) return null;
  return (
    <div className="space-y-2 border-t border-line px-4 py-3">
      {config.email && (
        <Toggle
          label={t("notifications.email")}
          checked={settings.email}
          onChange={(email) => save.mutate({ email })}
        />
      )}
      {canPush && browserOn !== null && (
        <Toggle label={t("notifications.browser")} checked={browserOn} onChange={toggleBrowser} />
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-xs text-muted">
      <span className="flex-1">{label}</span>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
