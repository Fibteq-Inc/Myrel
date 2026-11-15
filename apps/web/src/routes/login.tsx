import { useT } from "@myrel/i18n/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Monitor, Smartphone, TabletSmartphone } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { DOWNLOADS } from "../lib/downloads";
import { pendingGift } from "../lib/gift";
import { api, canChooseServer, server, serverInfoQuery, sessionQuery } from "../lib/api";
import { Checkbox } from "../components/ui/controls";
import { Turnstile } from "../components/turnstile";
import { LanguageSelect } from "../components/ui/language-select";
import { ServerPicker } from "../lib/server-picker";
import { Button, errorMessage, Input } from "../lib/ui";

export const Route = createFileRoute("/login")({
  // ?signup and ?forgot open those forms (the apps send people here for both); ?reset=done says a new password is set.
  // ?app marks a page opened from the desktop or mobile app: see LoginPage.
  validateSearch: (search: Record<string, unknown>): { signup?: boolean; forgot?: boolean; reset?: "done"; app?: boolean } => ({
    ...("signup" in search && { signup: true }),
    ...("forgot" in search && { forgot: true }),
    ...(search.reset === "done" && { reset: "done" as const }),
    ...("app" in search && { app: true }),
  }),
  beforeLoad: async ({ context, search }) => {
    // A desktop/mobile app with no server chosen yet has nothing to ask for a session.
    if (canChooseServer && server === "") return;
    // A page an app opened never leads into the web app, even with a session in this browser.
    if (search.app) return;
    if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

/**
 * Sign-in, sign-up and the password reset request. The apps send people here (?app) to sign up or
 * reset a password when the server's Turnstile check only passes on its own pages; such a visit
 * stays out of the web app, where Plan and billing sells through Stripe (App Store guideline
 * 3.1.1): it offers no web sign-in, and a finished sign-up signs this browser out again and only
 * says to go back to the app.
 */
function LoginPage() {
  const t = useT();
  const search = Route.useSearch();
  const fromApp = search.app === true;
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">(
    search.forgot ? "forgot" : search.signup || fromApp ? "signup" : "signin",
  );
  // The address of a sign-up an app opened, once it is done.
  const [appReady, setAppReady] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: info } = useQuery({ ...serverInfoQuery, enabled: !canChooseServer || server !== "" });
  const signUpAllowed = info?.auth.signUp !== false;
  const captcha = info?.auth.captcha ?? null;
  // The challenge only passes on the server's own pages, so the apps send people there to sign up.
  const signUpInBrowser = mode === "signup" && captcha !== null && canChooseServer;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    if (mode === "signup" && captcha && !captchaToken) {
      setError(t("login.captchaNeeded"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "signup") {
        await api.signUp({
          email,
          password,
          name: String(form.get("name")),
          acceptTerms: form.get("acceptTerms") === "on",
          captchaToken: captchaToken ?? undefined,
        });
        if (fromApp) {
          // The person signs in in the app; this browser keeps no session that could open the web app.
          await api.signOut().catch(() => {});
          setAppReady(email);
          return;
        }
      }
      else await api.signIn({ email, password });
      // Refetch now: the app layout reads the cached session, and invalidating alone keeps the old null.
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      // Someone who came from a gift link goes on to claim it.
      await navigate({ to: pendingGift() ? "/settings/billing" : "/" });
    } catch (err) {
      setError(errorMessage(err, t));
      // A token works once.
      if (mode === "signup" && captcha) setCaptchaReset((n) => n + 1);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      {canChooseServer && (
        <div className="w-full max-w-sm">
          <ServerPicker />
        </div>
      )}
      {appReady !== null && <AppReady email={appReady} verify={info?.auth.emailVerification === true} />}
      {(!canChooseServer || server !== "") && appReady === null && mode === "forgot" && (
        <ForgotForm onBack={fromApp ? null : () => setMode("signin")} />
      )}
      {(!canChooseServer || server !== "") && appReady === null && mode !== "forgot" && (
        <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
          {search.reset === "done" && mode === "signin" && <p className="text-sm text-muted">{t("login.resetDone")}</p>}
          <h1 className="text-2xl font-semibold">{mode === "signin" ? t("login.signInTitle") : t("login.signUpTitle")}</h1>
          {!signUpInBrowser && (
            <>
              {mode === "signup" && <Input name="name" placeholder={t("login.name")} required autoComplete="name" />}
              <Input name="email" type="email" placeholder={t("login.email")} required autoComplete="email" />
              <Input
                name="password"
                type="password"
                placeholder={t("login.password")}
                required
                minLength={8}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
              />
              {mode === "signup" && info?.legal && (
                <label className="flex items-start gap-2.5 text-sm text-muted">
                  <Checkbox name="acceptTerms" required className="mt-0.5" />
                  <span>
                    {t("login.accept.before")}
                    <a href={info.legal.terms} target="_blank" rel="noreferrer" className="text-fg underline">
                      {t("legal.terms")}
                    </a>
                    {t("login.accept.and")}
                    <a href={info.legal.privacy} target="_blank" rel="noreferrer" className="text-fg underline">
                      {t("legal.privacy")}
                    </a>
                    {t("login.accept.after")}
                  </span>
                </label>
              )}
            </>
          )}
          {mode === "signup" && captcha && !signUpInBrowser && (
            <Turnstile siteKey={captcha.siteKey} onToken={setCaptchaToken} resetKey={captchaReset} />
          )}
          {error && <p className="text-sm text-bad">{error}</p>}
          {signUpInBrowser ? (
            <div className="space-y-2 text-center text-sm text-muted">
              <p>{t("login.signUpInBrowser")}</p>
              <a href={`${server}/login?signup&app`} target="_blank" rel="noreferrer" className="text-fg underline">
                {t("login.openSignUp")}
              </a>
            </div>
          ) : (
            <Button type="submit" disabled={pending} className="w-full">
              {mode === "signin" ? t("login.signIn") : t("login.signUp")}
            </Button>
          )}
          {mode === "signin" && info?.auth.passwordReset && (
            <button type="button" className="w-full text-sm text-subtle hover:underline" onClick={() => setMode("forgot")}>
              {t("login.forgot")}
            </button>
          )}
          {fromApp && signUpAllowed ? (
            <p className="text-center text-sm text-subtle">{t("login.signInInApp")}</p>
          ) : signUpAllowed ? (
            <button
              type="button"
              className="w-full text-sm text-subtle hover:underline"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? t("login.toSignUp") : t("login.toSignIn")}
            </button>
          ) : (
            <p className="text-center text-sm text-subtle">{t("login.signUpClosed")}</p>
          )}
        </form>
      )}
      {/* Inside the desktop and mobile apps, or on a page one of them opened, the person already has one. */}
      {!canChooseServer && !fromApp && <GetTheApps />}
      <LanguageSelect />
    </main>
  );
}

/** What a sign-up an app opened ends on: no way on into the web app, only back to the app. */
function AppReady({ email, verify }: { email: string; verify: boolean }) {
  const t = useT();
  return (
    <div role="status" className="w-full max-w-sm space-y-3 text-center">
      <h1 className="text-2xl font-semibold">{t("login.appReadyTitle")}</h1>
      <p className="text-sm text-muted">{t("login.appReadyHint")}</p>
      {/* A server that verifies addresses sent the link on sign-up. */}
      {verify && <p className="text-sm text-muted">{t("login.appReadyVerify", { email })}</p>}
    </div>
  );
}

/** Links to the desktop app and the store listings, under the sign-in form on the web. */
function GetTheApps() {
  const t = useT();
  return (
    <nav aria-labelledby="get-apps" className="flex w-full max-w-sm flex-col items-center gap-2">
      <h2 id="get-apps" className="text-xs text-subtle">
        {t("login.getApps")}
      </h2>
      <ul className="flex flex-wrap justify-center gap-2">
        <AppLink href={DOWNLOADS.desktop} icon={<Monitor size={14} />} label={t("login.getDesktop")} hint={t("login.getDesktopHint")} />
        <AppLink href={DOWNLOADS.android} icon={<Smartphone size={14} />} label={t("login.getAndroid")} hint={t("login.getAndroidHint")} />
        {DOWNLOADS.ios && (
          <AppLink href={DOWNLOADS.ios} icon={<TabletSmartphone size={14} />} label={t("login.getIos")} hint={t("login.getIosHint")} />
        )}
      </ul>
    </nav>
  );
}

function AppLink({ href, icon, label, hint }: { href: string; icon: ReactNode; label: string; hint: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={hint}
        title={hint}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge px-3 text-sm text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true">{icon}</span>
        {label}
      </a>
    </li>
  );
}

/**
 * Asks for a link to set a new password. The page it leads to is on the server's own site, so the
 * apps send people there (where the Turnstile check passes, too).
 */
function ForgotForm({ onBack }: { onBack: (() => void) | null }) {
  const t = useT();
  const { data: info } = useQuery(serverInfoQuery);
  const captcha = info?.auth.captcha ?? null;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (captcha && !captchaToken) {
      setError(t("login.captchaNeeded"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const email = String(new FormData(e.currentTarget).get("email"));
      await api.requestPasswordReset({ email, redirectTo: `${location.origin}/reset-password`, captchaToken: captchaToken ?? undefined });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, t));
      if (captcha) setCaptchaReset((n) => n + 1);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">{t("login.forgotTitle")}</h1>
      {canChooseServer ? (
        <div className="space-y-2 text-center text-sm text-muted">
          <p>{t("login.forgotHint")}</p>
          <a href={`${server}/login?forgot&app`} target="_blank" rel="noreferrer" className="text-fg underline">
            {t("login.forgotInBrowser")}
          </a>
        </div>
      ) : sent ? (
        <p className="text-sm text-muted">{t("login.forgotSent")}</p>
      ) : (
        <>
          <p className="text-sm text-muted">{t("login.forgotHint")}</p>
          <Input name="email" type="email" placeholder={t("login.email")} required autoComplete="email" />
          {captcha && <Turnstile siteKey={captcha.siteKey} onToken={setCaptchaToken} resetKey={captchaReset} />}
          {error && <p className="text-sm text-bad">{error}</p>}
          <Button type="submit" disabled={pending} className="w-full">
            {t("login.forgotSend")}
          </Button>
        </>
      )}
      {/* Opened from an app (onBack null), the person signs in there. */}
      {onBack ? (
        <button type="button" className="w-full text-sm text-subtle hover:underline" onClick={onBack}>
          {t("login.toSignIn")}
        </button>
      ) : (
        <p className="text-center text-sm text-subtle">{t("login.signInInApp")}</p>
      )}
    </form>
  );
}
