import { createFileRoute } from "@tanstack/react-router";
import { Connectors } from "../../../components/connectors";

type ConnectorsSearch = { connector?: string; result?: string };

export const Route = createFileRoute("/_app/settings/connectors")({
  // `connector` and `result` come back from an OAuth sign-in (see /settings?section=connectors).
  validateSearch: (search: Record<string, unknown>): ConnectorsSearch => ({
    ...(typeof search.connector === "string" && { connector: search.connector }),
    ...(typeof search.result === "string" && { result: search.result }),
  }),
  component: ConnectorsSettings,
});

function ConnectorsSettings() {
  const { connector, result } = Route.useSearch();
  return <Connectors result={result} connectorId={connector} />;
}
