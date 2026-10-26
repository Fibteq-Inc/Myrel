import { createFileRoute, redirect } from "@tanstack/react-router";
import { setPendingGift } from "../lib/gift";

/** A gift link: keeps its token and goes on to the plan page, through sign-in when needed. */
export const Route = createFileRoute("/gift/$token")({
  beforeLoad: ({ params }) => {
    setPendingGift(params.token);
    throw redirect({ to: "/settings/billing" });
  },
});
