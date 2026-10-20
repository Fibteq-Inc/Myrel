import type { KeyValueStore, Platform } from "@myrel/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { secureKey } from "./secure-key";

const PREFIX = "altair:";

const storage: KeyValueStore = {
  get: (key) => AsyncStorage.getItem(PREFIX + key),
  set: (key, value) => (value === null ? AsyncStorage.removeItem(PREFIX + key) : AsyncStorage.setItem(PREFIX + key, value)),
};

/** Credentials go to the iOS Keychain / Android Keystore. */
const secrets: KeyValueStore = {
  get: (key) => SecureStore.getItemAsync(secureKey(PREFIX + key)),
  set: (key, value) =>
    value === null
      ? SecureStore.deleteItemAsync(secureKey(PREFIX + key))
      : SecureStore.setItemAsync(secureKey(PREFIX + key), value),
};

export const platform: Platform = {
  name: "mobile",
  storage,
  secrets,
  async notify({ title, body }) {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  },
  async openExternal(url) {
    await WebBrowser.openBrowserAsync(url);
  },
  async pickFiles({ multiple = false, accept = [] } = {}) {
    const result = await DocumentPicker.getDocumentAsync({
      multiple,
      type: accept.length ? accept : "*/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled) return [];
    return Promise.all(
      result.assets.map(async (a) => {
        const blob = await (await fetch(a.uri)).blob();
        return { name: a.name, type: a.mimeType ?? blob.type, size: a.size ?? blob.size, blob };
      }),
    );
  },
};
