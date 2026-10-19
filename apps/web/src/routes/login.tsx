import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, canChooseServer, server, sessionQuery } from "../lib/api";
import { ServerPicker } from "../lib/server-picker";
import { Button, errorMessage, Input } from "../lib/ui";

export const Route = createFileRoute("/login")({
  beforeLoad: async ({ context }) => {
    // A desktop/mobile app with no server chosen yet has nothing to ask for a session.
    if (canChooseServer && server === "") return;
    if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setPending(true);
    setError(null);
    try {
      if (mode === "signup") await api.signUp({ email, password, name: String(form.get("name")) });
      else await api.signIn({ email, password });
      // Refetch now: the app layout reads the cached session, and invalidating alone keeps the old null.
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await navigate({ to: "/" });
    } catch (err) {
      setError(errorMessage(err));
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
          <h1 className="text-2xl font-semibold">{mode === "signin" ? "Sign in to Altair" : "Create an account"}</h1>
          {mode === "signup" && <Input name="name" placeholder="Name" required autoComplete="name" />}
          <Input name="email" type="email" placeholder="Email" required autoComplete="email" />
          <Input
            name="password"
            type="password"
            placeholder="Password"
            required
            minLength={8}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
          {error && <p className="text-sm text-bad">{error}</p>}
          <Button type="submit" disabled={pending} className="w-full">
            {mode === "signin" ? "Sign in" : "Sign up"}
          </Button>
          <button
            type="button"
            className="w-full text-sm text-subtle hover:underline"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          >
            {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
          </button>
        </form>
      )}
    </main>
  );
}
