import { useT } from "@myrel/i18n/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, canChooseServer, server, serverInfoQuery, sessionQuery } from "../lib/api";
import { Checkbox } from "../components/ui/controls";
import { Turnstile } from "../components/turnstile";
import { LanguageSelect } from "../components/ui/language-select";
import { ServerPicker } from "../lib/server-picker";
import { Button, errorMessage, Input } from "../lib/ui";

export const Route = createFileRoute("/login")({
  // ?signup opens the sign-up form, e.g. from an app sending people to sign up in the browser.
  validateSearch: (search: Record<string, unknown>): { signup?: boolean } => ("signup" in search ? { signup: true } : {}),
  beforeLoad: async ({ context }) => {
    // A desktop/mobile app with no server chosen yet has nothing to ask for a session.
    if (canChooseServer && server === "") return;
    if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const t = useT();
  const search = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup">(search.signup ? "signup" : "signin");
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
      }
      else await api.signIn({ email, password });
      // Refetch now: the app layout reads the cached session, and invalidating alone keeps the old null.
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await navigate({ to: "/" });
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
      {(!canChooseServer || server !== "") && (
        <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
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
              <a href={`${server}/login?signup`} target="_blank" rel="noreferrer" className="text-fg underline">
                {t("login.openSignUp")}
              </a>
            </div>
          ) : (
            <Button type="submit" disabled={pending} className="w-full">
              {mode === "signin" ? t("login.signIn") : t("login.signUp")}
            </Button>
          )}
          {signUpAllowed ? (
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
      <LanguageSelect />
    </main>
  );
}
