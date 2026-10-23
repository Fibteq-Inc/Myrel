export type FileKind = "image" | "markdown" | "text" | "other";

/** Upload names start with a time stamp so they stay unique; people only need the original name. */
export function displayName(path: string) {
  const name = path.split("/").pop() ?? path;
  return path.startsWith("uploads/") ? name.replace(/^[0-9a-z]+-/, "") : name;
}

/** What the in-app preview can show, by content type with the extension as fallback. */
export function fileKind(type: string, path: string): FileKind {
  if (type.startsWith("image/") || (!type && /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(path))) return "image";
  if (/\.(md|markdown)$/i.test(path) || type.startsWith("text/markdown")) return "markdown";
  if (
    type.startsWith("text/") ||
    /json|xml|javascript|typescript|yaml|toml|csv|markdown/.test(type) ||
    /\.(md|txt|json|ya?ml|toml|csv|tsx?|jsx?|py|go|rs|sh|html?|css|sql)$/i.test(path)
  )
    return "text";
  return "other";
}

/** The base64 payload of a `data:` URL, as FileReader.readAsDataURL gives it. */
export function dataUrlBase64(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? "" : dataUrl.slice(comma + 1);
}
