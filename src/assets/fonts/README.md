# Bundled fonts

Two variable faces, both under the SIL Open Font License 1.1, which permits
bundling inside an application. The license texts ship alongside the fonts as
`Figtree-OFL.txt` and `EBGaramond-OFL.txt`; keep them next to the files.

| File                        | Face                                       | Upstream                                                                                  | Axis           |
| --------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------- |
| `figtree-variable.woff2`    | Figtree — Erik Kennedy                     | [google/fonts `ofl/figtree`](https://github.com/google/fonts/tree/main/ofl/figtree)       | `wght` 300–900 |
| `ebgaramond-variable.woff2` | EB Garamond — Georg Duffner, Octavio Pardo | [google/fonts `ofl/ebgaramond`](https://github.com/google/fonts/tree/main/ofl/ebgaramond) | `wght` 400–800 |

Both were subset with `fontTools.subset` to latin, latin-ext, general
punctuation, currency, arrows and combining marks (plus Cyrillic for EB
Garamond, which covers it), keeping `kern, liga, clig, calt, ccmp, mark, mkmk,
locl, rlig, ss01`, then written as `woff2`. That takes Figtree to 21 KB and
EB Garamond to 99 KB.

Neither face contains the macOS modifier glyphs `⌘ U+2318`, `⌥ U+2325`,
`⇧ U+21E7` or `⌃ U+2303`, so `KeycapPill` gets those from the `system-ui`
fallback in `--fs-font-sans`. The Cyrillic and CJK locales also fall through
to `system-ui` for Figtree, which is what they render in today.

Why these two rather than the alternatives: the comparison — cap-height-matched
renders of every candidate against the reference screenshots, with the width and
x-height errors for each — is in `~/handy-review/ui-survey/MEASUREMENTS.md`.

`@font-face` declarations live in `src/styles/theme.css`.
