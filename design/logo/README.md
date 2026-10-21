# RFDeck logo

The mark is two diversity meters, antenna A and antenna B, as they appear on every channel card.

| File | Use |
|---|---|
| `rfdeck-mark.svg` | Primary mark (five segments), for dark UI. Used in the app header. |
| `rfdeck-mark-light.svg` | Primary mark for light backgrounds. |
| `rfdeck-mark-small.svg` / `-small-light.svg` | Solid-bar version for **24 px and under**, where segments blur together. |
| `rfdeck-icon.svg` | App icon: primary mark on a rounded dark tile. |
| `rfdeck-icon-small.svg` | App icon at 24 px and under. |
| `rfdeck-icon-fullbleed.svg` | Square, unrounded tile for platforms that apply their own mask (iOS, PWA). |
| `rfdeck-favicon-16.svg` | Pixel-aligned 16 px favicon. |

## Rules

- Above 24 px use the five-segment mark; at 24 px and under use the solid bars.
- Wordmark: "RFDeck" set in Geist SemiBold, −0.03em tracking, beside the mark with a gap of about 30% of the mark's height. Leave the wordmark neutral and let the mark carry the color.
- Colors: accent `#3DD9E8` and unlit segments `#3A3F47` on dark; accent `#0A7482` and unlit `#C3C8CF` on light. Tile `#121418`, edge `#262A30`.
- Don't add glow, gradients or outlines, and don't change the lit-segment pattern (A = 4 of 5, B = 3 of 5).

## Where it's wired in

- `apps/web/src/assets/logo-mark.svg`: header and mobile header (`RootLayout.tsx`)
- `apps/web/public/favicon.png`: 64 px render of the hinted 16 px favicon
- `apps/web/public/logo-mark-192.png`, `logo-mark-512.png`: apple-touch and large icons (full bleed)
- `apps/desktop/resources/icon.ico`, `icon.png`: picked up automatically by electron-builder (`buildResources: resources`). The ICO uses the solid bars at 16 and 24 px and the five-segment mark from 32 px up.
