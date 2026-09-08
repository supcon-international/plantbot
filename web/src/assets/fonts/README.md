# Local fonts

Sources: [Tier0-Design-System](https://github.com/FREEZONEX/Tier0-Design-System/tree/52e01e94c18188668f47dfe7664f27cfde1690f6/fonts), IBM Plex under the included SIL Open Font License.

`PlantbotSansSCUI-*.woff2` contains the CJK glyphs used by Plantbot UI copy, derived from IBM Plex Sans SC Regular/Medium. The modified subsets use the new family name **Plantbot Sans SC UI**, respecting the reserved Plex font name. Other user-provided CJK glyphs use the configured OS font fallbacks. This avoids downloading multi-megabyte full CJK fonts just to render the language switch.

Regenerate after changing Chinese copy with `python3 scripts/subset-ui-fonts.py /path/to/Tier0-Design-System/fonts` (requires `fonttools[woff]`). The script updates the font files and CSS unicode ranges together.

`IBMPlexMono-Regular.ttf` is the unmodified official font for 3D map labels. Vite supplies its hashed, deployment-prefix-aware asset URL; the map does not fetch a default Troika font from a CDN.
