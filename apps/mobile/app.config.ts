import type { ExpoConfig } from "expo/config";

// The hosted Altair's EAS project (@fibteqs-organization/altair). Self-hosters who build their
// own app point these at their Expo project; setting EAS_PROJECT_ID to "" unlinks it.
const easProjectId = process.env.EAS_PROJECT_ID ?? "c4c8d3bc-48ec-4c79-b7c3-982877904746";
const easOwner = process.env.EAS_OWNER ?? "fibteqs-organization";

const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

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
    // Firebase config for FCM pushes: the path of google-services.json, which EAS provides
    // through the GOOGLE_SERVICES_JSON file variable (the file itself stays out of git).
    ...(googleServicesFile && { googleServicesFile }),
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { color: "#8b9bff" }],
  ],
  experiments: { typedRoutes: true },
  // OTA updates only reach builds of the same app version (bump `version` for native changes).
  runtimeVersion: { policy: "appVersion" },
  extra: easProjectId ? { eas: { projectId: easProjectId } } : {},
  ...(easProjectId && { owner: easOwner, updates: { url: `https://u.expo.dev/${easProjectId}` } }),
};

export default config;
