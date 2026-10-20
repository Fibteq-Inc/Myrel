import type { NotificationConfig } from "@altair/protocol";
import type { VapidKeys } from "./webpush";

/** Web Push keys, when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set. */
export function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    // Push services (Apple's in particular) want a real contact.
    subject: env.VAPID_SUBJECT || env.BETTER_AUTH_URL || "mailto:admin@example.com",
  };
}

/** Email goes out through Cloudflare Email Service when the EMAIL binding and EMAIL_FROM are set. */
export function emailEnabled(env: Env): boolean {
  return Boolean(env.EMAIL && env.EMAIL_FROM);
}

export function notificationConfig(env: Env): NotificationConfig {
  return { webPushKey: vapidKeys(env)?.publicKey ?? null, email: emailEnabled(env) };
}

export type Email = { to: string; subject: string; text: string; html: string };

export async function sendEmail(env: Env, email: Email): Promise<void> {
  await env.EMAIL.send({ from: parseAddress(env.EMAIL_FROM), ...email });
}

/** "Myrel <altair@example.com>" or a bare address. */
export function parseAddress(value: string): string | { name: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m ? { name: m[1]!.replace(/^"|"$/g, ""), email: m[2]! } : value.trim();
}

export type ExpoMessage = { to: string; title: string; body: string; data: Record<string, unknown> };

/**
 * Sends through Expo's push service (for the mobile app). Returns the tokens
 * Expo reports as no longer registered, so they can be dropped.
 */
export async function sendExpoPush(env: Env, messages: ExpoMessage[]): Promise<string[]> {
  if (messages.length === 0) return [];
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages.map((m) => ({ ...m, sound: "default" }))),
  });
  if (!res.ok) throw new Error(`Expo push ${res.status}: ${await res.text()}`);
  const { data = [] } = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
  return data.flatMap((d, i) => (d.details?.error === "DeviceNotRegistered" ? [messages[i]!.to] : []));
}
