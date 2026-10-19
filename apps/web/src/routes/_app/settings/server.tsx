import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Notice, Section } from "../../../components/settings";
import { adminSettingsQuery, api, serverInfoQuery } from "../../../lib/api";
import { errorMessage } from "../../../lib/ui";

export const Route = createFileRoute("/_app/settings/server")({
  component: ServerSettings,
});

function ServerSettings() {
  const { data: settings, error } = useQuery(adminSettingsQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (signUpEnabled: boolean) => api.updateAdminSettings({ signUpEnabled }),
    onSuccess: (s) => {
      queryClient.setQueryData(adminSettingsQuery.queryKey, s);
      return queryClient.invalidateQueries({ queryKey: serverInfoQuery.queryKey });
    },
  });

  if (error) return <Notice>{errorMessage(error)}</Notice>;
  return (
    <>
      <Section title="Sign-ups" description="Who can create an account on this server.">
        <label className="flex items-start gap-3 rounded-xl border border-line bg-raised px-4 py-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={settings?.signUpEnabled ?? false}
            disabled={!settings || update.isPending}
            onChange={(e) => update.mutate(e.target.checked)}
          />
          <span>
            <span className="block font-medium">Anyone can sign up</span>
            <span className="block text-[13px] text-subtle">
              When off, only existing accounts can sign in. People invited to a project can still create an account
              with the invited email.
            </span>
          </span>
        </label>
        {update.error && <Notice>{errorMessage(update.error)}</Notice>}
      </Section>
      <Section
        title="Shared model keys"
        description={
          <>
            Add keys every project can use under <Link to="/settings/keys" className="text-accent hover:underline">Model keys</Link>.
          </>
        }
      />
    </>
  );
}
