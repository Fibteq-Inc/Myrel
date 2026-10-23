/**
 * Where people get the Myrel apps. The one place to change these links. The apps connect to any
 * Myrel server, so self-hosted servers show the same links.
 */
export const DOWNLOADS = {
  /** Installers for macOS, Windows and Linux; the desktop updater reads the same release. */
  desktop: "https://github.com/Fibteq-Inc/myrel/releases/latest",
  android: "https://play.google.com/store/apps/details?id=io.fibteq.myrel",
  /** Not on the App Store yet (TestFlight only); set the listing URL once it is, and the link appears. */
  ios: null as string | null,
};
