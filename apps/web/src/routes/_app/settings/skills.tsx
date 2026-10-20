import { createFileRoute } from "@tanstack/react-router";
import { Skills } from "../../../components/skills";

export const Route = createFileRoute("/_app/settings/skills")({
  component: () => <Skills />,
});
