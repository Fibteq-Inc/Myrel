import { useT } from "@myrel/i18n/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { IconRail } from "../components/shell/icon-rail";
import { AppShell } from "../components/shell/shell";
import { useState } from "react";
import { api, canChooseServer, server, serverInfoQuery, sessionQuery } from "../lib/api";
import { drafts } from "../lib/drafts";
import { disableWebPush } from "../lib/push";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    if (canChooseServer && server === "") throw redirect({ to: "/login" });
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: "/login" });
    return { user: session.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    // This browser's push subscription is the account's: a shared browser must not keep getting its notifications.
    await disableWebPush().catch(() => {});
    await api.signOut();
    queryClient.clear();
    // Unsent text is the account's too.
    drafts.clear();
    await navigate({ to: "/login" });
  }

  return (
    <AppShell rail={<IconRail user={user} onSignOut={signOut} />} banner={<VerifyBanner email={user.email} verified={user.emailVerified} />}>
      <Outlet />
    </AppShell>
  );
}

/** Until the address is verified: what waits for it (invitations, the cloud sandbox) and a way to get a new link. */
function VerifyBanner({ email, verified }: { email: string; verified?: boolean }) {
  const t = useT();
  const { data: info } = useQuery(serverInfoQuery);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  if (verified || !info?.auth.emailVerification) return null;
  async function resend() {
    setState("sending");
    try {
      // The link opens in a browser, so it comes back to the server's own address.
      await api.sendVerificationEmail(email, server || location.origin);
      setState("sent");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-2 text-[13px] text-body">
      <span className="min-w-0 flex-1">{t("verify.banner", { email })}</span>
      {state === "failed" && <span className="text-bad">{t("verify.failed")}</span>}
      {state === "sent" ? (
        <span className="text-muted">{t("verify.sent")}</span>
      ) : (
        <button type="button" onClick={resend} disabled={state === "sending"} className="font-medium text-accent hover:underline disabled:opacity-50">
          {t("verify.resend")}
        </button>
      )}
    </div>
  );
}
