import type { ExpoConfig } from "expo/config";

// The hosted Myrel EAS project (@fibteqs-organization/myrel). Self-hosters who build their
// own app point these at their Expo project; setting EAS_PROJECT_ID to "" unlinks it.
const easProjectId = process.env.EAS_PROJECT_ID ?? "e078b447-75b4-45d5-afa5-413a7c079de1";
const easOwner = process.env.EAS_OWNER ?? "fibteqs-organization";

const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

const config: ExpoConfig = {
  name: "Myrel",
  slug: "myrel",
  scheme: "myrel",
  version: "0.1.0",
  orientation: "portrait",
  // Four-petal mark, rendered from assets/icon.svg; re-export the PNGs when it changes.
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#0e0e10",
  ios: {
    bundleIdentifier: "io.fibteq.myrel",
    supportsTablet: true,
    // Only HTTPS/TLS, which is exempt from export compliance; saves the question on every upload.
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: "io.fibteq.myrel",
    adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#5148e6" },
    // Firebase config for FCM pushes: the path of google-services.json, which EAS provides
    // through the GOOGLE_SERVICES_JSON file variable (the file itself stays out of git).
    ...(googleServicesFile && { googleServicesFile }),
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { color: "#8b9bff", icon: "./assets/notification-icon.png" }],
  ],
  experiments: { typedRoutes: true },
  // OTA updates only reach builds of the same app version (bump `version` for native changes).
  runtimeVersion: { policy: "appVersion" },
  extra: easProjectId ? { eas: { projectId: easProjectId } } : {},
  ...(easProjectId && { owner: easOwner, updates: { url: `https://u.expo.dev/${easProjectId}` } }),
};

export default config;
