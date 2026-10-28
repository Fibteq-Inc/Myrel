/** The text a file preview shows, with the path it was read from. */
export type PreviewText = { path: string; text: string };

/**
 * The preview's text after a read of `path` finished. A refetch of the same file (the window got
 * focus again, say) keeps the old object when nothing changed, so the preview is not drawn again
 * and keeps its scroll position.
 */
export function nextPreviewText(old: PreviewText | null, path: string, text: string): PreviewText {
  return old?.path === path && old.text === text ? old : { path, text };
}

/** The text to show for `path`: none while another file's text is still loaded. */
export function previewTextFor(loaded: PreviewText | null, path: string): string | null {
  return loaded?.path === path ? loaded.text : null;
}
