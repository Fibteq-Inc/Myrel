import { useT } from "@altair/i18n/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Notice, Section } from "../../../components/settings";
import { adminSettingsQuery, api, serverInfoQuery } from "../../../lib/api";
import { errorMessage } from "../../../lib/ui";

export const Route = createFileRoute("/_app/settings/server")({
  component: ServerSettings,
});

function ServerSettings() {
  const t = useT();
  const { data: settings, error } = useQuery(adminSettingsQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (signUpEnabled: boolean) => api.updateAdminSettings({ signUpEnabled }),
    onSuccess: (s) => {
      queryClient.setQueryData(adminSettingsQuery.queryKey, s);
      return queryClient.invalidateQueries({ queryKey: serverInfoQuery.queryKey });
    },
  });

  if (error) return <Notice>{errorMessage(error, t)}</Notice>;
  return (
    <>
      <Section title={t("server.signUps")} description={t("server.signUpsDescription")}>
        <label className="flex items-start gap-3 rounded-xl border border-line bg-raised px-4 py-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={settings?.signUpEnabled ?? false}
            disabled={!settings || update.isPending}
            onChange={(e) => update.mutate(e.target.checked)}
          />
          <span>
            <span className="block font-medium">{t("server.anyoneCanSignUp")}</span>
            <span className="block text-[13px] text-subtle">{t("server.anyoneCanSignUpHint")}</span>
          </span>
        </label>
        {update.error && <Notice>{errorMessage(update.error, t)}</Notice>}
      </Section>
      <Section
        title={t("server.sharedKeys")}
        description={
          <>
            {t("server.sharedKeysBefore")}{" "}
            <Link to="/settings/keys" className="text-accent hover:underline">
              {t("settings.keys")}
            </Link>
            {t("server.sharedKeysAfter")}
          </>
        }
      />
    </>
  );
}
