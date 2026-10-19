import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { List, Notice, Row, Section } from "../../../components/settings";
import { api, myInvitesQuery, projectsQuery } from "../../../lib/api";
import { Button, errorMessage, GhostButton } from "../../../lib/ui";

export const Route = createFileRoute("/_app/settings/invites")({
  component: InvitesSettings,
});

function InvitesSettings() {
  const { data: invites = [] } = useQuery(myInvitesQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const accept = useMutation({
    mutationFn: (id: string) => api.acceptInvite(id),
    onSuccess: async ({ projectId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: myInvitesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey }),
      ]);
      await navigate({ to: "/projects/$projectId", params: { projectId } });
    },
  });
  const decline = useMutation({
    mutationFn: (id: string) => api.declineInvite(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: myInvitesQuery.queryKey }),
  });

  return (
    <Section title="Invitations" description="Projects you have been invited to.">
      <List empty="No pending invitations.">
        {invites.map((i) => (
          <Row key={i.id}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{i.projectName}</div>
              <div className="text-xs text-subtle">
                {i.invitedBy} invited you as {i.role}
              </div>
            </div>
            <GhostButton type="button" disabled={decline.isPending} onClick={() => decline.mutate(i.id)}>
              Decline
            </GhostButton>
            <Button type="button" className="h-8" disabled={accept.isPending} onClick={() => accept.mutate(i.id)}>
              Join
            </Button>
          </Row>
        ))}
      </List>
      {(accept.error || decline.error) && <Notice>{errorMessage(accept.error ?? decline.error)}</Notice>}
    </Section>
  );
}
