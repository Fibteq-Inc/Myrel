import type { ApiClient } from "@myrel/client";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { type Href, usePathname, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { platform } from "./platform";
import { notificationNavigation, notificationPath } from "./push-target";

const TOKEN_KEY = "push-token";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Asks for notification permission and registers this device's Expo push
 * token with the server, so "thread finished" and "decision waiting" reach
 * the user while the app (and its WebSocket) is closed. Quietly does nothing
 * on simulators, without permission, or before the app is linked to EAS.
 */
export async function registerForPush(api: ApiClient): Promise<void> {
  if (!Device.isDevice) return;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Myrel",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return;
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api.registerPush({ kind: "expo", token });
  await platform.storage.set(TOKEN_KEY, token);
}

/** Stops pushes to this device for the signed-out account. */
export async function unregisterPush(api: ApiClient): Promise<void> {
  const token = await platform.storage.get(TOKEN_KEY);
  if (!token) return;
  await platform.storage.set(TOKEN_KEY, null);
  await api.unregisterPush(token);
}

/**
 * Opens the project or thread a tapped notification points at, from whichever project is open:
 * a thread of another project opens in that project, under its own live connection.
 */
export function useNotificationRouting() {
  const router = useRouter();
  const pathname = usePathname();
  // Read when a tap arrives, so moving around the app does not replay the last one.
  const current = useRef(pathname);
  current.current = pathname;
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const path = notificationPath(response.notification.request.content.data);
    if (!path) return;
    const step = notificationNavigation(current.current, path);
    if (step === "none") return;
    if (step === "switch") router.dismissTo("/");
    router.push(path as Href);
  }, [response, router]);
}
