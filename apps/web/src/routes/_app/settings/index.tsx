import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Field, Notice, Section } from "../../../components/settings";
import { api, meQuery, sessionQuery } from "../../../lib/api";
import { Button, errorMessage, Input } from "../../../lib/ui";

export const Route = createFileRoute("/_app/settings/")({
  component: AccountSettings,
});

function AccountSettings() {
  const { data: me } = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.name);
  const rename = useMutation({
    mutationFn: () => api.updateProfile({ name: name.trim() }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }),
      ]),
  });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const password = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
    },
  });

  function onRename(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) rename.mutate();
  }

  function onPassword(e: FormEvent) {
    e.preventDefault();
    password.mutate();
  }

  return (
    <>
      <Section title="Profile" description={`Signed in as ${me.email}${me.role === "admin" ? " · server admin" : ""}`}>
        <form onSubmit={onRename} className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </Field>
          </div>
          <Button type="submit" disabled={rename.isPending || !name.trim() || name.trim() === me.name}>
            Save
          </Button>
        </form>
        {rename.error && <Notice>{errorMessage(rename.error)}</Notice>}
      </Section>

      <Section title="Password" description="Changing it signs you out on your other devices.">
        <form onSubmit={onPassword} className="space-y-3">
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={password.isPending}>
            Change password
          </Button>
          {password.error && <Notice>{errorMessage(password.error)}</Notice>}
          {password.isSuccess && <Notice tone="ok">Password changed.</Notice>}
        </form>
      </Section>
    </>
  );
}
