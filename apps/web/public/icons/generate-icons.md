# Generating PWA Icons for RahatNet

Replace the placeholder files in this directory with proper branded icons before going to production.

## Required files

| File | Size | Purpose |
|---|---|---|
| `icon-72.png` | 72×72 | Android home screen (legacy) |
| `icon-96.png` | 96×96 | Android home screen |
| `icon-128.png` | 128×128 | Chrome Web Store |
| `icon-144.png` | 144×144 | Windows tile |
| `icon-152.png` | 152×152 | iOS home screen |
| `icon-192.png` | 192×192 | Android home screen (standard) |
| `icon-384.png` | 384×384 | Android splash |
| `icon-512.png` | 512×512 | Android splash (hi-res) |
| `icon-maskable-192.png` | 192×192 | Android adaptive icon |
| `icon-maskable-512.png` | 512×512 | Android adaptive icon (hi-res) |
| `badge-96.png` | 96×96 | Push notification badge |
| `shortcut-report-96.png` | 96×96 | PWA shortcut: Report a need |
| `shortcut-tasks-96.png` | 96×96 | PWA shortcut: My tasks |
| `shortcut-warroom-96.png` | 96×96 | PWA shortcut: War room |

## Design spec

- Background colour: `#F27527` (RahatNet orange-brown)
- Icon: white RahatNet logo mark (the "R" or wave symbol)
- Maskable icons: safe zone = 80% of canvas (40% padding each side)

## Recommended tool

Use https://www.pwabuilder.com/imageGenerator to generate all sizes from one 512×512 source.
Or use the `sharp` npm package:

```bash
npm install -g sharp-cli
# Then for each size:
sharp-cli input.png -o icon-192.png --resize 192 192
```
