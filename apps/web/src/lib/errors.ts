import { createErrorReporter } from "@myrel/client";
import { api, platform } from "./api";

/** Sends the app's unexpected errors to the server, for admins to see in Settings › Server › Errors. */
export const reportError = createErrorReporter({
  platform: platform.name === "desktop" ? "desktop" : "web",
  send: (input) => api.reportClientError(input),
});
