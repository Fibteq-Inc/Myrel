import * as ImagePicker from "expo-image-picker";

/**
 * Photos from the phone's library, to attach to a message (the system picker, so no library
 * permission is asked for). Names fall back to a time stamp when the picker gives none.
 */
export async function pickPhotos(): Promise<{ name: string; blob: Blob }[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: 10,
  });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map(async (a, i) => {
      const blob = await (await fetch(a.uri)).blob();
      const ext = (a.mimeType ?? blob.type).split("/")[1]?.replace("jpeg", "jpg") || "jpg";
      return { name: a.fileName || `photo-${Date.now()}-${i + 1}.${ext}`, blob };
    }),
  );
}
