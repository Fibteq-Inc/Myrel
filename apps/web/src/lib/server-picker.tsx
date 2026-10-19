import { normalizeServerUrl, probeServer } from "@altair/client";
import { useT } from "@altair/i18n/react";
import { type FormEvent, useState } from "react";
import { server, switchServer } from "./api";
import { Button, errorMessage, Input } from "./ui";

/** Shows which Altair server the app talks to and lets the user switch to another (e.g. self-hosted). */
export function ServerPicker() {
  const t = useT();
  const [editing, setEditing] = useState(server === "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const origin = normalizeServerUrl(String(new FormData(e.currentTarget).get("server")));
      await probeServer(origin);
      await switchServer(origin);
    } catch (err) {
      setError(errorMessage(err, t));
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <p className="flex items-center justify-between text-sm text-subtle">
        <span className="truncate">{t("server.current", { host: new URL(server).host })}</span>
        <button type="button" className="hover:underline" onClick={() => setEditing(true)}>
          {t("server.change")}
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label htmlFor="server" className="text-sm text-subtle">
        {t("server.label")}
      </label>
      <div className="flex gap-2">
        <Input
          id="server"
          name="server"
          placeholder="altair.example.com"
          defaultValue={server}
          required
          autoComplete="url"
          inputMode="url"
        />
        <Button type="submit" disabled={pending}>
          {t("server.connect")}
        </Button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
    </form>
  );
}
