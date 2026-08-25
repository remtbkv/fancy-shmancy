/**
 * Appearance: dark, always.
 *
 * The app used to offer system / light / dark. It no longer does — the light
 * palette is not the one this fork is looked at in, so there is no setting, no
 * OS following and nothing to persist. `data-theme="dark"` on the document root
 * outranks the `prefers-color-scheme` media query in `theme.css`, and is set
 * before React mounts so no frame paints in the wrong palette.
 *
 * Rust does the same to the native window chrome at startup and normalizes any
 * stored `theme` to `dark` on load, so a store written by an older build cannot
 * flip anything back.
 */

/** Force the dark palette on this document. Safe to call more than once. */
export const applyDarkTheme = (): void => {
  document.documentElement.dataset.theme = "dark";
};
