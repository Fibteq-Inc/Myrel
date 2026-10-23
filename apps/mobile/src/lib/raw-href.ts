/**
 * react-native-marked puts a "/" in front of every link without a scheme, so `#thr_…` reached us as
 * `/#thr_…` (opened as a file) and `notes/a.md` as `/notes/a.md`. Links are wrapped in this scheme
 * while parsing, which it leaves alone, and unwrapped when drawn.
 */
const SCHEME = "myrelhref:";

export function wrapHref(href: string): string {
  return SCHEME + href;
}

export function unwrapHref(href: string): string {
  return href.startsWith(SCHEME) ? href.slice(SCHEME.length) : href;
}
