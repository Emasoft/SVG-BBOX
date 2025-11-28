# SVG-BBOX Claude Code Project Instructions

## Publishing Policy

**NEVER push to GitHub or publish to npm without explicit user approval.**

- Always commit changes locally
- Wait for user review before pushing commits
- Wait for user approval before running `npm publish`
- Add this to the todo list: "Wait for user review before pushing"

## JavaScript/TypeScript Code Fixing

**CRITICAL: Always use the correct code-fixer agent for the language!**

- For JavaScript/TypeScript files (.js, .cjs, .mjs, .ts, .tsx): **ALWAYS use
  `js-code-fixer` agent**
- For Python files (.py): use `python-code-fixer` agent
- NEVER use `python-code-fixer` on JavaScript/TypeScript files - it's the wrong
  tool!
- The `js-code-fixer` agent runs ESLint, TypeScript compiler (tsc), and Prettier
- Can fix up to 20 JS/TS files in parallel by spawning 20 `js-code-fixer` agents
  simultaneously

## Critical Discovery: npm Trusted Publishing with OIDC

### Problem Context

After enabling npm trusted publishing for automated package releases, the GitHub
Actions workflow consistently failed with authentication errors despite having
`permissions.id-token: write` configured correctly. Multiple attempts to
manually extract and use OIDC tokens from `setup-node` outputs failed, with
`NODE_AUTH_TOKEN` appearing empty in workflow logs.

### Root Cause Analysis

**The fundamental issue:** npm trusted publishing with OIDC authentication
requires **npm CLI version 11.5.1 or later**. This requirement is not
immediately obvious in the documentation but is critical for automated
workflows.

**Version dependency chain:**

- Node.js 20 ships with npm 10.x (insufficient)
- Node.js 24 ships with npm 11.6.0 (sufficient)
- The npm version is determined by the Node.js version installed
- Using older Node.js versions makes OIDC authentication impossible regardless
  of workflow configuration

**Why manual token extraction failed:**

- Modern npm CLI (11.5.1+) handles OIDC authentication internally
- The `setup-node` action doesn't expose OIDC tokens in outputs when npm can
  handle it automatically
- Attempting to manually extract and set `NODE_AUTH_TOKEN` from
  `setup-node.outputs.registry-token` is unnecessary and doesn't work
- The npm CLI automatically detects GitHub Actions OIDC environment and performs
  authentication

### The Solution

**Minimal working configuration for npm trusted publishing:**

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # Required for OIDC

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24' # Critical: Use Node.js 24 for npm 11.6.0
          # NO registry-url needed
          # NO step ID needed

      - run: npm ci

      - run: npm test

      - run: npm publish --access public
        # NO --provenance flag needed (automatic)
        # NO NODE_AUTH_TOKEN environment variable needed
        # npm CLI handles everything automatically
```

**What NOT to do:**

```yaml
# ❌ WRONG - These are unnecessary and don't work:
- uses: actions/setup-node@v4
  id: setup-node # Don't need step ID
  with:
    node-version: '20' # Too old, npm 10.x doesn't support OIDC
    registry-url: 'https://registry.npmjs.org' # Not needed

- run: npm publish --access public --provenance # --provenance is automatic
  env:
    NODE_AUTH_TOKEN: ${{ steps.setup-node.outputs.registry-token }} # Empty, not needed
```

### Key Insights

1. **npm CLI version is critical:** Only npm 11.5.1+ supports OIDC trusted
   publishing. Check your Node.js version's bundled npm version.

2. **Automatic authentication:** With npm 11.5.1+, the CLI automatically:
   - Detects GitHub Actions OIDC environment
   - Exchanges OIDC token with npm registry
   - Generates and publishes provenance attestations
   - No manual token handling required

3. **Provenance is automatic:** The `--provenance` flag is automatically applied
   when using trusted publishing. Don't add it manually.

4. **No token extraction needed:** Unlike older authentication methods, you
   don't extract or pass tokens through environment variables. The npm CLI
   handles the entire OIDC flow internally.

5. **setup-node simplicity:** The `setup-node` action only needs the Node.js
   version. No `registry-url`, no step ID, no output capture.

### Debugging Tips

If npm publish fails with authentication errors:

1. **Verify npm version in workflow:**

   ```yaml
   - name: Verify npm version
     run: npm --version # Should be 11.5.1 or higher
   ```

2. **Check npm trusted publishing configuration:**
   - Go to npm package settings → Publishing access
   - Verify GitHub Actions is listed as a trusted publisher
   - Ensure repository, workflow name, and environment match exactly

3. **Verify workflow permissions:**

   ```yaml
   permissions:
     contents: read
     id-token: write # Must be present
   ```

4. **Common failure modes:**
   - 404 errors: npm trusted publishing not configured on npm's website
   - ENEEDAUTH errors: npm CLI version too old (< 11.5.1)
   - Empty NODE_AUTH_TOKEN: Attempting manual token extraction with modern npm
     (don't do this)

### npm Version Reference

| Node.js Version | npm Version | OIDC Support |
| --------------- | ----------- | ------------ |
| Node.js 18      | npm 9.x     | ❌ No        |
| Node.js 20      | npm 10.x    | ❌ No        |
| Node.js 22      | npm 10.x    | ❌ No        |
| Node.js 24      | npm 11.6.0  | ✅ Yes       |

### References

- [npm trusted publishing with OIDC (GitHub Changelog)](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
- [Trusted publishing for npm packages (npm Docs)](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Community Discussion on npm OIDC](https://github.com/orgs/community/discussions/176761)

### Lessons Learned

1. **Version requirements matter:** Always verify the tool version requirements
   for features, not just the service configuration. npm trusted publishing
   requires npm 11.5.1+, but this wasn't immediately obvious.

2. **Modern tools abstract complexity:** The npm CLI 11.5.1+ handles OIDC
   automatically. Older patterns of manually extracting and passing tokens are
   obsolete and don't work.

3. **Documentation gaps:** Official documentation may not explicitly state
   version requirements. Web searches and community discussions often reveal
   these critical details.

4. **Simplicity over complexity:** The working solution is simpler than expected
   (no token handling, no registry-url, no --provenance flag). If a solution
   seems overly complex, there may be a missing fundamental requirement.

5. **Test locally when possible:** While OIDC authentication can't be tested
   locally, verifying the npm CLI version locally (`npm --version`) can catch
   version mismatches early.

---

## Project Structure

This project provides SVG bounding box utilities for both browser and Node.js
environments.

### Key Files

- `SvgVisualBBox.js` - Browser-only library (UMD format)
- `SvgVisualBBox.min.js` - Minified browser library
- `svg-bbox.cjs` - Main CLI wrapper
- `sbb-*.cjs` - Individual CLI tools (CommonJS)
- `lib/` - Shared utility modules (CommonJS)

### Build Process

- Uses Terser for minification
- Maintains UMD format for browser compatibility
- Version synchronization across package.json and version.cjs

### Testing Strategy

- **Vitest** for unit/integration tests (server-side code)
- **Playwright** for E2E tests (browser code via Puppeteer)
- Coverage excludes browser-only code (runs in Puppeteer, can't be measured by
  V8)
- Pre-commit hooks run linter, typecheck, and tests

### CI/CD

- **GitHub Actions** for all automation
- **pnpm** for fast dependency management
- **npm trusted publishing** for releases (Node.js 24 required)
- Tests run in parallel for speed

### Development Notes

- Font rendering tolerance set to 4px (cross-platform differences)
- Integration tests use temp directories to avoid polluting project root
- SVG comparison tool has configurable thresholds and alignment modes
