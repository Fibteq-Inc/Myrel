import { api, platform } from "./api";

/** Web Push works in browsers with a service worker; the desktop and mobile apps use their own channels. */
export const webPushSupported =
  platform.name === "web" &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window;

async function registration() {
  return navigator.serviceWorker.register("/sw.js");
}

/** This browser's current push subscription, if any. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!webPushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes this browser and registers it with the server. */
export async function enableWebPush(publicKey: string): Promise<void> {
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("Notifications are blocked for this site in the browser settings.");
  }
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.registerPush({ kind: "webpush", endpoint: json.endpoint, keys: json.keys });
}

export async function disableWebPush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api.unregisterPush(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
