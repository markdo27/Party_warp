# Party Warp

A type-able, animated retro psychedelic sticker: chunky 70s lettering on a blobby red
silhouette with a pink outline, warped live on the GPU. The default reads
**UNIDENTIFIED DANCING OBJECTS**.

**Live page:** https://markdo27.github.io/Party_warp/

## Features

- **Live text.** Click the sticker and type. It re-flows and resizes as you go (up to six lines).
- **Motion.** Fluid warp with speed, intensity, frequency and swell. There's also a
  stop-motion "boil" mode at 4–15 fps.
- **Letters with a life of their own.** Random letters stretch like extended cuts while
  others lean into italics, one letter at a time.
- **Designs.** Sticker, Marquee (scrolling colour bands with a tagline), and Wallpaper (tilted tiling).
- **Beginner controls.** Four tabs guide you through Text, Style, Motion, and Export. Start with
  Gentle, Liquid, or Wild motion presets; open advanced settings when you want finer control.
- **Print textures.** Film grain, a halftone dot screen and ordered dithering.
- **Type.** Archivo Black built in; upload your own TTF / OTF / WOFF / WOFF2.
- **Export.**
  - PNG: copy or download, opaque or transparent.
  - SVG: layered vectors for editing.
  - Video: MP4 or WebM.
  - A PNG sequence (ZIP).
  - A single tileable marquee line.

## Stack

React 19 · Vite 8 · Tailwind CSS 4 · lucide-react · WebGL2. It's a single component:
[`src/RetroStickerWarp.jsx`](src/RetroStickerWarp.jsx).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run e2e        # end-to-end tests (Playwright, uses your installed Chrome)
npm run build      # static site in dist/
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/pages.yml`.
