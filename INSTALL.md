# SVG-BBOX Installation Guide

Complete installation instructions for svg-bbox using bun, npm, or pnpm.

## Quick Install

```bash
# bun (recommended)
bun add svg-bbox

# npm
npm install svg-bbox

# pnpm
pnpm add svg-bbox
```

That's it! No additional steps required.

---

## Installation Types

### Development Dependency

Use when svg-bbox is only needed during development:

```bash
# bun
bun add -d svg-bbox

# npm
npm install --save-dev svg-bbox

# pnpm
pnpm add -D svg-bbox
```

### Production Dependency

Use when svg-bbox is needed at runtime:

```bash
# bun
bun add svg-bbox

# npm
npm install svg-bbox

# pnpm
pnpm add svg-bbox
```

### Global Installation

Use for system-wide CLI access:

```bash
# bun
bun add -g svg-bbox

# npm
npm install -g svg-bbox

# pnpm
pnpm add -g svg-bbox
```

After global installation, CLI commands are available anywhere:

```bash
svg-bbox --help
sbb-getbbox sample.svg
sbb-svg2png input.svg output.png
sbb-compare file1.svg file2.svg
sbb-extract input.svg --list

# Every tool that takes a single SVG accepts --fbf-frame N to pin a
# specific frame of an FBF.SVG (Frame-By-Frame SVG from svg2fbf):
sbb-getbbox anim.fbf.svg --fbf-frame 7
sbb-svg2png anim.fbf.svg out.png --fbf-frame 7 --scale 4
```

### Browser via CDN (no install required)

The minified UMD bundle is served from both major npm CDNs and works in any
modern browser via a `<script>` tag — no `npm install`, no bundler:

```html
<!-- Pick either CDN, both serve the same file from npm -->
<script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js"></script>
<!-- or -->
<script src="https://cdn.jsdelivr.net/npm/svg-bbox@latest/SvgVisualBBox.min.js"></script>

<script>
  const { svg } = SvgVisualBBox.extractFbfFrame(svgString, 7);
  const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#myElement');
</script>
```

Pin a specific version with `@1.2.1` in place of `@latest` for production.

### Library import (npm package)

After `bun add svg-bbox` / `npm install svg-bbox`, the right entry point is
picked automatically based on your runtime — see the
[Choose your runtime](README.md#choose-your-runtime) cheatsheet in the README
for the full per-scenario table:

```js
// Browser bundler / Bun — full library
import {
  extractFbfFrame,
  getSvgElementVisualBBoxTwoPassAggressive
} from 'svg-bbox';

// Node.js (CJS or ESM) — FBF helpers + actionable stubs for DOM-bound functions
const { extractFbfFrame } = require('svg-bbox'); // CJS
import { extractFbfFrame } from 'svg-bbox'; // ESM (named or default import)

// Slim FBF-only entry — works in every runtime, smallest dependency surface
const { extractFbfFrame } = require('svg-bbox/fbf'); // CJS
import { extractFbfFrame } from 'svg-bbox/fbf'; // ESM
```

In Node, bbox functions need a real DOM, so calling them directly throws an
actionable error. Use the
[Puppeteer-injection pattern](README.md#pattern-c--bbox-computation-in-node-puppeteer-injection-pattern)
or just shell out to one of the CLI bins.

---

## Replacing npm with bun

### Local (dev dependency)

```bash
npm uninstall svg-bbox 2>/dev/null; bun add -d svg-bbox
```

### Local (production)

```bash
npm uninstall svg-bbox 2>/dev/null; bun add svg-bbox
```

### Global

```bash
npm uninstall -g svg-bbox 2>/dev/null; bun add -g svg-bbox
```

### Fresh project setup

```bash
cd /path/to/project && bun init -y && bun add -d svg-bbox
```

---

## Verification

```bash
# Check version
bunx svg-bbox --version

# Quick test
echo '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' > test.svg
bunx sbb-getbbox test.svg
rm test.svg
```

---

## Troubleshooting

### First Run is Slow

On first use, puppeteer downloads Chromium (~150MB). This is normal and only
happens once.

### Permission Errors (Global Install)

```bash
# bun uses ~/.bun/bin - usually no issues
bun add -g svg-bbox

# npm may need prefix config
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g svg-bbox
```

### Linux Missing Dependencies

Chromium requires system libraries on Linux:

```bash
# Debian/Ubuntu
sudo apt-get install -y ca-certificates fonts-liberation libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
  libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 xdg-utils
```

---

## Uninstallation

```bash
# bun
bun remove svg-bbox      # local
bun remove -g svg-bbox   # global

# npm
npm uninstall svg-bbox   # local
npm uninstall -g svg-bbox # global
```

---

## Cheatsheet

| Action      | bun                   | npm                 | pnpm                   |
| ----------- | --------------------- | ------------------- | ---------------------- |
| Install     | `bun add svg-bbox`    | `npm i svg-bbox`    | `pnpm add svg-bbox`    |
| Dev install | `bun add -d svg-bbox` | `npm i -D svg-bbox` | `pnpm add -D svg-bbox` |
| Global      | `bun add -g svg-bbox` | `npm i -g svg-bbox` | `pnpm add -g svg-bbox` |
| Remove      | `bun remove svg-bbox` | `npm un svg-bbox`   | `pnpm rm svg-bbox`     |

---

## Requirements

- **Node.js**: >= 24.0.0
- **OS**: macOS, Linux, Windows

## Links

- [npm package](https://www.npmjs.com/package/svg-bbox)
- [GitHub repository](https://github.com/Emasoft/SVG-BBOX)
- [API Docs](https://github.com/Emasoft/SVG-BBOX/blob/main/API.md)
- [unpkg CDN](https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js)
- [jsDelivr CDN](https://cdn.jsdelivr.net/npm/svg-bbox@latest/SvgVisualBBox.min.js)
- [Choose your runtime cheatsheet](README.md#choose-your-runtime)
- [`svg2fbf` companion repo](https://github.com/Emasoft/svg2fbf) (FBF.SVG format
  spec)
