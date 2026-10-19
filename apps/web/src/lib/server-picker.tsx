import { normalizeServerUrl, probeServer } from "@altair/client";
import { type FormEvent, useState } from "react";
import { server, switchServer } from "./api";
import { Button, errorMessage, Input } from "./ui";

/** Shows which Altair server the app talks to and lets the user switch to another (e.g. self-hosted). */
export function ServerPicker() {
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
      setError(errorMessage(err));
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <p className="flex items-center justify-between text-sm text-neutral-500">
        <span className="truncate">Server: {new URL(server).host}</span>
        <button type="button" className="hover:underline" onClick={() => setEditing(true)}>
          Change
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label htmlFor="server" className="text-sm text-neutral-500">
        Altair server
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
          Connect
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
