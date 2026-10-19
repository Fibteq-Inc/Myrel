import { useRouter } from "expo-router";
import { useCallback } from "react";
import { Linking } from "react-native";

/**
 * Links in messages: web pages (artifacts above all) open in the in-app
 * viewer so the user stays in the conversation; anything else (mailto:,
 * tel:) goes to the OS.
 */
export function useOpenLink() {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      if (/^https?:\/\//i.test(href)) router.push({ pathname: "/artifact", params: { url: href } });
      else void Linking.openURL(href).catch(() => {});
    },
    [router],
  );
}
