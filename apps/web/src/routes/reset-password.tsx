import { useT } from "@myrel/i18n/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { Button, errorMessage, Input } from "../lib/ui";

/**
 * Sets a new password with the token from an emailed link: a forgotten password, or the first
 * one after an address is verified (?first=1, see firstVerification on the server). Every session
 * ends, so it goes on to sign-in.
 */
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string; first?: boolean; error?: string } => ({
    ...(typeof search.token === "string" && { token: search.token }),
    ...("first" in search && { first: true }),
    ...(typeof search.error === "string" && { error: search.error }),
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const { token, first, error: linkError } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password"));
    if (newPassword !== String(form.get("confirm"))) {
      setError(t("reset.mismatch"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.resetPassword({ token: token!, newPassword });
      await navigate({ to: "/login", search: { reset: "done" } });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{first ? t("reset.firstTitle") : t("reset.title")}</h1>
        {!token || linkError ? (
          <p className="text-sm text-bad">{t("reset.invalid")}</p>
        ) : (
          <>
            {first && <p className="text-sm text-muted">{t("reset.firstHint")}</p>}
            <Input name="password" type="password" placeholder={t("reset.password")} required minLength={8} autoComplete="new-password" />
            <Input name="confirm" type="password" placeholder={t("reset.confirm")} required minLength={8} autoComplete="new-password" />
            {error && <p className="text-sm text-bad">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {t("reset.save")}
            </Button>
          </>
        )}
      </form>
    </main>
  );
}
