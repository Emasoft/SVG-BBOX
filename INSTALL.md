# SVG-BBOX Installation Guide

Complete installation instructions for svg-bbox using npm, bun, or pnpm.

## Table of Contents

- [Quick Install](#quick-install)
- [Installation Methods](#installation-methods)
  - [Using bun (Recommended)](#using-bun-recommended)
  - [Using npm](#using-npm)
  - [Using pnpm](#using-pnpm)
- [Installation Types](#installation-types)
  - [Local Development Dependency](#local-development-dependency)
  - [Local Production Dependency](#local-production-dependency)
  - [Global Installation](#global-installation)
- [Replacing Existing Installations](#replacing-existing-installations)
- [Troubleshooting](#troubleshooting)
  - [Bun Blocked Postinstall Scripts](#bun-blocked-postinstall-scripts)
  - [Permission Errors](#permission-errors)
  - [Version Conflicts](#version-conflicts)
- [Verification](#verification)
- [Uninstallation](#uninstallation)

---

## Quick Install

```bash
# bun (recommended)
bun add -d svg-bbox

# npm
npm install --save-dev svg-bbox

# pnpm
pnpm add -D svg-bbox
```

---

## Installation Methods

### Using bun (Recommended)

Bun is the fastest package manager and is recommended for svg-bbox.

#### Basic Installation

```bash
bun add svg-bbox
```

#### Handling Blocked Postinstall Scripts

Bun blocks untrusted postinstall scripts by default for security. If you see:

```
Blocked 1 postinstall. Run `bun pm untrusted` for details.
```

**Option 1: Trust the package (recommended)**

```bash
# See what's blocked
bun pm untrusted

# Trust svg-bbox and its dependencies
bun pm trust svg-bbox

# If puppeteer is blocked (svg-bbox dependency), trust it too
bun pm trust puppeteer

# Then reinstall
bun add svg-bbox
```

**Option 2: Trust all blocked packages at once**

```bash
# List untrusted packages
bun pm untrusted

# Trust all untrusted packages
bun pm trust --all

# Reinstall
bun install
```

**Option 3: Run with lifecycle scripts enabled (one-time)**

```bash
bun add svg-bbox --trust
```

#### Why Scripts Are Blocked

svg-bbox depends on puppeteer, which downloads a Chromium binary during postinstall.
Bun blocks this by default to prevent malicious packages from running arbitrary code.
Trusting the package allows the Chromium download to proceed.

### Using npm

```bash
npm install svg-bbox
```

npm runs postinstall scripts by default, so no additional steps are needed.

### Using pnpm

```bash
pnpm add svg-bbox
```

If postinstall scripts are blocked:

```bash
pnpm add svg-bbox --ignore-scripts=false
```

---

## Installation Types

### Local Development Dependency

Use this when svg-bbox is only needed during development (testing, building, etc.):

```bash
# bun
bun add -d svg-bbox

# npm
npm install --save-dev svg-bbox

# pnpm
pnpm add -D svg-bbox
```

This adds svg-bbox to `devDependencies` in package.json.

### Local Production Dependency

Use this when svg-bbox is needed at runtime:

```bash
# bun
bun add svg-bbox

# npm
npm install svg-bbox

# pnpm
pnpm add svg-bbox
```

This adds svg-bbox to `dependencies` in package.json.

### Global Installation

Use this to install CLI tools system-wide:

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
```

---

## Replacing Existing Installations

### Replace npm with bun (Local)

```bash
npm uninstall svg-bbox 2>/dev/null; bun add svg-bbox --trust
```

### Replace npm with bun (Dev Dependency)

```bash
npm uninstall svg-bbox 2>/dev/null; bun add -d svg-bbox --trust
```

### Replace npm with bun (Global)

```bash
npm uninstall -g svg-bbox 2>/dev/null; bun add -g svg-bbox --trust
```

### Clean Install in Specific Project

```bash
cd /path/to/your/project && \
rm -rf node_modules/svg-bbox && \
npm uninstall svg-bbox 2>/dev/null; \
bun add -d svg-bbox --trust
```

### Fresh Project Setup

```bash
cd /path/to/your/project && \
bun init -y && \
bun add -d svg-bbox --trust
```

---

## Troubleshooting

### Bun Blocked Postinstall Scripts

**Error:**
```
Blocked 1 postinstall. Run `bun pm untrusted` for details.
```

**Cause:** Bun's security feature blocks postinstall scripts from untrusted packages.
svg-bbox depends on puppeteer, which needs to download Chromium.

**Solution:**

```bash
# View blocked packages
bun pm untrusted

# Trust the packages
bun pm trust svg-bbox
bun pm trust puppeteer

# Or trust all at once
bun pm trust --all

# Reinstall
bun install
```

**Alternative - Install with trust flag:**

```bash
bun add svg-bbox --trust
```

### Permission Errors

**Error:**
```
EACCES: permission denied
```

**Solution for global installs:**

```bash
# bun (uses ~/.bun/bin, usually no sudo needed)
bun add -g svg-bbox

# npm with proper permissions
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g svg-bbox
```

### Version Conflicts

**Check installed version:**

```bash
# bun
bun pm ls | grep svg-bbox

# npm
npm list svg-bbox

# pnpm
pnpm list svg-bbox
```

**Force latest version:**

```bash
# bun
bun add svg-bbox@latest --trust

# npm
npm install svg-bbox@latest

# pnpm
pnpm add svg-bbox@latest
```

### Puppeteer/Chromium Issues

If Chromium fails to download:

```bash
# Set custom Chromium download location
export PUPPETEER_CACHE_DIR=~/.cache/puppeteer

# Reinstall
bun remove svg-bbox && bun add svg-bbox --trust
```

On Linux, you may need additional dependencies:

```bash
# Debian/Ubuntu
sudo apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils
```

---

## Verification

### Verify Installation

```bash
# Check version
npx svg-bbox --version
# or with bun
bunx svg-bbox --version

# Run a quick test
echo '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' > test.svg
npx sbb-getbbox test.svg
rm test.svg
```

### Verify Global Installation

```bash
# Check if CLI is in PATH
which svg-bbox

# Check version
svg-bbox --version

# Test a command
sbb-getbbox --help
```

### Verify Package Contents

```bash
# bun
bun pm ls svg-bbox

# npm
npm list svg-bbox

# Check package location
ls node_modules/svg-bbox/
```

---

## Uninstallation

### Local Uninstall

```bash
# bun
bun remove svg-bbox

# npm
npm uninstall svg-bbox

# pnpm
pnpm remove svg-bbox
```

### Global Uninstall

```bash
# bun
bun remove -g svg-bbox

# npm
npm uninstall -g svg-bbox

# pnpm
pnpm remove -g svg-bbox
```

### Complete Cleanup

```bash
# Remove from all package managers
npm uninstall svg-bbox 2>/dev/null
npm uninstall -g svg-bbox 2>/dev/null
bun remove svg-bbox 2>/dev/null
bun remove -g svg-bbox 2>/dev/null
pnpm remove svg-bbox 2>/dev/null
pnpm remove -g svg-bbox 2>/dev/null

# Clear puppeteer cache (optional)
rm -rf ~/.cache/puppeteer
```

---

## Summary Cheatsheet

| Action | bun | npm | pnpm |
|--------|-----|-----|------|
| Install (prod) | `bun add svg-bbox --trust` | `npm i svg-bbox` | `pnpm add svg-bbox` |
| Install (dev) | `bun add -d svg-bbox --trust` | `npm i -D svg-bbox` | `pnpm add -D svg-bbox` |
| Install (global) | `bun add -g svg-bbox --trust` | `npm i -g svg-bbox` | `pnpm add -g svg-bbox` |
| Uninstall | `bun remove svg-bbox` | `npm un svg-bbox` | `pnpm rm svg-bbox` |
| List | `bun pm ls` | `npm list` | `pnpm list` |
| Trust scripts | `bun pm trust --all` | N/A | N/A |

---

## Requirements

- **Node.js**: >= 24.0.0 (for CLI tools)
- **Browser**: Chromium (auto-downloaded by puppeteer)
- **OS**: macOS, Linux, Windows

## Links

- [npm package](https://www.npmjs.com/package/svg-bbox)
- [GitHub repository](https://github.com/Emasoft/SVG-BBOX)
- [API documentation](https://github.com/Emasoft/SVG-BBOX/blob/main/API.md)
