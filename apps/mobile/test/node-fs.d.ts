// The app has no Node types; the palette test only reads apps/web's stylesheet.
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
}
