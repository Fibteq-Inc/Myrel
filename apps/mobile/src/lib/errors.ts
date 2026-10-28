import { type ApiClient, createErrorReporter } from "@myrel/client";
import Constants from "expo-constants";

/**
 * Sends errors nothing caught to the signed-in server, for admins to see in Settings › Server ›
 * Errors, under the screen's route pattern. The app's own handler (the red screen in development,
 * the crash in production) still runs after. Returns the undo.
 */
export function reportUncaughtErrors(api: ApiClient, screen: () => string): () => void {
  const report = createErrorReporter({
    platform: "mobile",
    version: Constants.expoConfig?.version,
    send: (input) => api.reportClientError(input),
  });
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    report(error, screen());
    previous(error, isFatal);
  });
  return () => ErrorUtils.setGlobalHandler(previous);
}
