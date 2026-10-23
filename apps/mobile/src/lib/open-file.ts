import { Directory, File, Paths } from "expo-file-system";
import { dataUrlBase64, displayName } from "./files";

/**
 * Hands a downloaded file to the phone: Quick Look on iOS (zoom, share, save to Files or Photos),
 * an app that can view it on Android. The copy goes to the cache, replacing the last one opened.
 */
export async function openWithSystem(dataUrl: string, path: string, type: string) {
  const dir = new Directory(Paths.cache, "open");
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true });
  const file = new File(dir, displayName(path));
  await file.write(dataUrlBase64(dataUrl), { encoding: "base64" });
  await file.preview({ title: displayName(path), mimeType: type || undefined });
}
