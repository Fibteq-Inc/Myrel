import type { ExpoConfig } from "expo/config";

// EAS fills these in once the project is linked (`eas init`); local dev works without them.
const easProjectId = process.env.EAS_PROJECT_ID;

const config: ExpoConfig = {
  name: "Altair",
  slug: "altair",
  scheme: "altair",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  backgroundColor: "#0e0e10",
  ios: {
    bundleIdentifier: "io.fibteq.altair",
    supportsTablet: true,
  },
  android: {
    package: "io.fibteq.altair",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { color: "#8b9bff" }],
  ],
  experiments: { typedRoutes: true },
  extra: easProjectId ? { eas: { projectId: easProjectId } } : {},
  ...(easProjectId && { owner: process.env.EAS_OWNER, updates: { url: `https://u.expo.dev/${easProjectId}` } }),
};

export default config;
