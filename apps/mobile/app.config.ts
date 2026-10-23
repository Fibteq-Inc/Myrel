import type { ExpoConfig } from "expo/config";

// The hosted Myrel EAS project (@fibteqs-organization/myrel). Self-hosters who build their
// own app point these at their Expo project; setting EAS_PROJECT_ID to "" unlinks it.
const easProjectId = process.env.EAS_PROJECT_ID ?? "e078b447-75b4-45d5-afa5-413a7c079de1";
const easOwner = process.env.EAS_OWNER ?? "fibteqs-organization";

const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

// Store builds get their version from the release tag (MYREL_RELEASE_TAG=mobile-v0.3.0, set by
// .github/workflows/mobile.yml); local and manual builds use package.json's.
const releaseVersion = process.env.MYREL_RELEASE_TAG?.match(/^mobile-v(\d+\.\d+\.\d+)$/)?.[1];
const version = releaseVersion ?? (require("./package.json") as { version: string }).version;

const config: ExpoConfig = {
  name: "Myrel",
  slug: "myrel",
  scheme: "myrel",
  version,
  orientation: "portrait",
  // Four-petal mark, rendered from assets/icon.svg; re-export the PNGs when it changes.
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
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
    // Firebase config for FCM pushes: the path of google-services.json, which the store build and
    // update workflows write from the GOOGLE_SERVICES_JSON secret (the file itself stays out of git).
    ...(googleServicesFile && { googleServicesFile }),
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { color: "#8b9bff", icon: "./assets/notification-icon.png" }],
    // Photos are only picked from the library, through the system picker: no camera or microphone.
    [
      "expo-image-picker",
      { photosPermission: "Myrel attaches the photos you pick to your messages.", cameraPermission: false, microphonePermission: false },
    ],
  ],
  experiments: { typedRoutes: true },
  // OTA updates reach every build with the same native fingerprint; a version bump alone keeps them flowing.
  runtimeVersion: { policy: "fingerprint" },
  extra: easProjectId ? { eas: { projectId: easProjectId } } : {},
  ...(easProjectId && { owner: easOwner, updates: { url: `https://u.expo.dev/${easProjectId}` } }),
};

export default config;
