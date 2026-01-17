# SVG-BBOX Claude Code Project Instructions

## Publishing Policy

**NEVER push to GitHub or publish to npm without explicit user approval.**

- Always commit changes locally
- Wait for user review before pushing commits
- Wait for user approval before running releases
- Add this to the todo list: "Wait for user review before pushing"

## Release Workflow

**Use the automated release script for all releases.**

### Quick Start (Bash Script)

```bash
# Release with version bump
./scripts/release.sh patch   # 1.0.10 → 1.0.11
./scripts/release.sh minor   # 1.0.10 → 1.1.0
./scripts/release.sh major   # 1.0.10 → 2.0.0

# Release specific version
./scripts/release.sh 1.0.11
```

### Quick Start (Python Tool - Recommended)

The Python release tool provides the same functionality with better error handling,
comprehensive validation, and multi-ecosystem support.

```bash
# Activate the virtual environment
source scripts/release/.venv/bin/activate

# Release with version bump
python -m release release patch --dry-run  # Preview changes first
python -m release release patch --yes      # Execute release

# Other useful commands
python -m release validate --verbose  # Run all 18 validators
python -m release status              # Show current version info
python -m release discover --verbose  # Detect available publishers
python -m release check security      # Run security checks only
python -m release init-config         # Regenerate config file
```

**Python Tool Advantages:**
- 188 automated tests ensuring reliability
- 18 validators across 6 categories (git, version, security, quality, CI, dependencies)
- Auto-discovery of npm, Homebrew, GitHub, PyPI, crates.io publishers
- Rich terminal output with progress indicators
- Proper error messages with fix suggestions
- Multi-ecosystem support (Node.js, Python, Rust, Go)

### What the Release Script Does (Proper Sequence)

The script follows the **correct order** to avoid race conditions:

1. **Validates prerequisites** - gh CLI, npm, pnpm, jq, git-cliff, authentication
2. **Checks working directory** - Must be clean, on main branch
3. **Runs quality checks** - Linting, type checking, all tests
4. **Bumps version** - Updates package.json and pnpm-lock.yaml
5. **Generates release notes** - Uses git-cliff to generate formatted changelog from commits
6. **Updates CHANGELOG.md** - Auto-updates changelog with git-cliff (see below)
7. **Commits version bump** - Creates commit for version change + CHANGELOG.md
8. **Creates git tag locally** - Tag not pushed yet (avoids race condition)
9. **Pushes commits to GitHub** - Triggers CI workflow
10. **Waits for CI workflow** - Monitors lint, typecheck, test, e2e, coverage (3-10 min)
11. **Creates GitHub Release** - 🔑 **Pushes tag + creates release atomically**
12. **Waits for Publish workflow** - Monitors npm publish workflow (up to 5 min)
13. **Verifies npm publication** - Confirms package is live on npm
14. **Verifies bun installation** - Tests package works with bun add + CLI execution

### Why This Order Matters

**CRITICAL: Proper sequence prevents race conditions and failed releases**

- ✅ **Create tag locally first** - Prevents workflow triggering too early
- ✅ **Push commits only** - Triggers CI to verify tests pass
- ✅ **Wait for CI** - Don't release if tests fail
- ✅ **GitHub Release pushes tag atomically** - No race condition
- ✅ **Release exists before workflow runs** - Proper provenance
- ❌ **WRONG:** Push tag → workflow starts → create release (race condition)

The GitHub Actions workflow is triggered by the tag push, but creating the
GitHub Release first ensures:

- Release notes are properly attached to the tag
- The release is visible on GitHub before npm
- npm package links back to GitHub Release
- Proper audit trail for compliance

### Manual Release (Not Recommended)

If you must release manually (script fails), follow this **exact sequence**:

```bash
# 1. Bump version
npm version patch --no-git-tag-version  # or minor/major

# 2. Commit version bump
git add package.json pnpm-lock.yaml
git commit -m "chore(release): Bump version to X.Y.Z"

# 3. Create tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# 4. Push commits and tag
git push origin main
git push origin vX.Y.Z

# 5. Create GitHub Release (REQUIRED FIRST)
gh release create vX.Y.Z --title "vX.Y.Z" --notes "Release notes here"

# 6. Wait for GitHub Actions to publish to npm (automatic)
gh run watch

# 7. Verify npm publication
npm view svg-bbox version
```

### Troubleshooting

**Tag already exists:**

```bash
git tag -d vX.Y.Z          # Delete local tag
git push origin :vX.Y.Z    # Delete remote tag (if pushed)
```

**GitHub Actions workflow not running:**

- Check workflow file: `.github/workflows/publish.yml`
- Verify tag format: Must be `vX.Y.Z` (with 'v' prefix)
- Check workflow triggers: Should trigger on `tags: v*`

**npm publish fails in workflow:**

- Verify npm trusted publishing is configured on npmjs.com
- Check Node.js version in workflow (must be 24 for npm 11.6.0)
- Review workflow logs: `gh run view --log`

**gh release create fails with "target_commitish is invalid":**

This error occurs when using `--target HEAD`:

```
HTTP 422: Validation Failed
Release.target_commitish is invalid
```

**Root Cause:** The GitHub Releases API does NOT accept "HEAD" as a valid
`target_commitish` value. "HEAD" is a local git reference with no meaning to
GitHub's API.

**Valid values for --target:**

| Value Type | Example | Works? |
|------------|---------|--------|
| Branch name | `main`, `develop` | ✅ Yes |
| Full commit SHA | `df967eb695543bd326bd42f22867877d673b1f48` | ✅ Yes |
| Git reference | `HEAD`, `HEAD~1` | ❌ No |

**Solution:** The release script uses the explicit commit SHA stored during
`push_commits_to_github()` in the `PUSHED_COMMIT_SHA` variable:

```bash
# Correct approach - use explicit commit SHA
gh release create "v$VERSION" --target "$PUSHED_COMMIT_SHA" ...

# WRONG - HEAD is not resolved by gh CLI
gh release create "v$VERSION" --target HEAD ...
```

**Why this is a gh CLI limitation:** The `gh` CLI passes `--target` values
literally to the GitHub API without resolving git references first. It should
resolve HEAD to the actual SHA before making the API call, but it doesn't.

### Version Tag Format Requirements

**CRITICAL: Git tags MUST use the 'v' prefix (e.g., v1.0.12)**

The version tag format is tightly integrated across multiple systems:

1. **publish.yml workflow** (`.github/workflows/publish.yml`):
   - Triggers on tags matching `v*` pattern (line 5-6)
   - Without 'v' prefix, npm publish workflow will NOT trigger

2. **release.sh script** (`scripts/release.sh`):
   - Always creates tags with 'v' prefix: `v${VERSION}`
   - Used in: `create_git_tag()`, `create_github_release()`, changelog URLs

3. **GitHub Release conventions**:
   - Releases are titled `v1.0.12`
   - Changelog links use `v${PREVIOUS_TAG}...v${VERSION}` format

4. **npm semantic versioning**:
   - npm internally uses `v` prefix for git tags
   - Package version in package.json does NOT have 'v' (just `1.0.12`)

**Version Format Summary:**

| Location                     | Format     | Example   |
| ---------------------------- | ---------- | --------- |
| Git tag                      | vX.Y.Z     | v1.0.12   |
| GitHub Release title         | vX.Y.Z     | v1.0.12   |
| package.json version         | X.Y.Z      | 1.0.12    |
| npm registry version         | X.Y.Z      | 1.0.12    |
| release.sh internal VERSION  | X.Y.Z      | 1.0.12    |

**DO NOT remove the 'v' prefix** - it would break the publish workflow trigger.

### Release Script Security Safeguards

**SECURITY: ANSI Code Contamination Prevention**

The release script has comprehensive safeguards to prevent ANSI color codes from
breaking git tag creation. This addresses a critical bug where colored terminal
output contaminated version strings.

**Historical Bugs:**

**Bug 1 (Fixed in commit f1730c8):** ANSI code contamination from log functions
```bash
fatal: 'v?[0;34mℹ ?[0mBumping version (patch)...' is not a valid tag name
```

**Bug 2 (Fixed in commit f826ead):** npm lifecycle hook output contamination
```bash
fatal: 'v?[0;34mℹ ?[0mBumping version (patch)...
?[0;32m✓?[0m Version bumped to
> ersion
> node ersion.cjs

sg-bbox v1.0.12
1.0.12' is not a valid tag name
```

**Root Cause:** npm lifecycle hooks (`"version": "node version.cjs"` in package.json)
output multiline content to stdout that CANNOT be suppressed with `2>/dev/null`.

**Safeguards Implemented:**

1. **`strip_ansi()` function** - Removes all ANSI escape sequences:
   - Strips `\x1b[...m` and `\033[...m` patterns
   - Removes control characters `\000-\037`
   - Multiple sed/tr passes for robust cleaning

2. **`validate_version()` function** - Three-tier validation:
   - Empty/whitespace check
   - ANSI code detection (paranoid double-check)
   - Semver format validation: `^[0-9]+\.[0-9]+\.[0-9]+$`
   - Detailed error messages with hex dump for debugging

3. **npm hook output isolation (commit f826ead):**
   - Silence npm ENTIRELY: `npm version patch >/dev/null 2>&1`
   - Read version from package.json (source of truth) using `get_current_version()`
   - Check npm exit code to detect failures
   - Prevents lifecycle hook output from contaminating VERSION variable

4. **Applied in critical functions:**
   - `bump_version()`: Silence npm + read from package.json + validate
   - `set_version()`: Silence npm + verify + validate
   - `create_git_tag()`: Strip + validate before tag creation
   - `create_github_release()`: Strip + validate before release

**Defensive Layers:**

1. **Prevent:** Silence npm entirely (`>/dev/null 2>&1`) to prevent hook output
2. **Source of Truth:** Read version from package.json instead of capturing npm output
3. **Detect:** Strip ANSI codes from package.json value (paranoid safeguard)
4. **Validate:** Verify semver format before use
5. **Verify:** Check npm exit code to detect failures

**Why These Safeguards Matter:**

- **npm lifecycle hooks are unavoidable:** They're a fundamental feature of npm
- **Hooks output to stdout:** Cannot be suppressed with `2>/dev/null`
- **Capturing npm output is unreliable:** Any script that captures `npm version` output will face this contamination issue
- **package.json is the source of truth:** After `npm version` succeeds, reading package.json guarantees a clean version string
- Prevents release script failures due to colored output and hook contamination
- Ensures git tags have clean, valid names
- Maintains consistency between package.json and git tags
- Provides clear error messages when npm fails

**Key Insight: The Source of Truth Pattern**

The npm lifecycle hook contamination bug revealed a critical lesson about defensive programming: **capturing command output is inherently fragile when lifecycle hooks are involved**.

The solution demonstrates the "source of truth" pattern:
- **Instead of:** Capturing `npm version` output (which can be polluted by hooks, ANSI codes, verbose output)
- **We do:** Silence npm entirely → verify success via exit code → read from package.json (authoritative source)

This pattern is applicable beyond npm:
- Any command that triggers hooks, plugins, or extensions may pollute stdout
- Exit codes are reliable signals of success/failure
- Configuration files are authoritative sources after commands modify them
- Validation should happen on the authoritative data, not captured output

**If Tag Creation Fails:**

The safeguards will show:
```
✗ Invalid version format: '<contaminated-string>'
✗ Expected semver format (e.g., 1.0.12)
✗ Got: <hex dump of actual bytes>
```

This helps diagnose whether the issue is:
- ANSI codes in the output
- npm verbose mode enabled
- Unexpected characters in version string
- Shell environment issues

### Release Reliability Safeguards

**RELIABILITY: Pre-commit Hook Bypass and Test Artifact Cleanup**

The release script has safeguards to prevent flaky test failures from blocking
releases after comprehensive validation has already passed.

**Historical Bug (Fixed in commits b0296de, fb4a1f4):**

Pre-commit hooks would re-run tests during the version bump commit, causing
release failures due to race conditions in parallel test execution, even though
the release script had already validated everything.

```
Error: Pre-commit tests failed during release commit
- Tests passed during validation phase
- Tests failed during commit due to parallel execution race conditions
- Release blocked despite all validations passing
```

**Safeguards Implemented:**

1. **`--no-verify` flag on release commit:**
   - The `commit_version_bump()` function uses `git commit --no-verify`
   - WHY: Release script has already run comprehensive validation (linting, type
     checking, tests, security scans)
   - Pre-commit hooks would be redundant AND can fail due to timing issues
   - This is safe because validation has already completed successfully

2. **`cleanup_test_artifacts()` function:**
   - Automatically removes test temp directories before working directory check
   - Patterns cleaned: `temp_*`, `test_batch.txt`, `test_regenerated.svg`,
     `*-last-conversation.txt`
   - Also cleans: `tests/.tmp-*`, `tests/test-cli-security-temp`
   - WHY: Test artifacts in .gitignore still show in `git status --short`,
     confusing users with "uncommitted changes" errors

**Why These Safeguards Matter:**

- **Validation is comprehensive:** Release script runs 40+ validators before commit
- **Pre-commit would be redundant:** Same checks would run again, wasting time
- **Race conditions are real:** Parallel tests can fail non-deterministically
- **Test artifacts pollute status:** Gitignored files appear in error messages
- **User confusion:** "Uncommitted changes" for temp files is misleading

**When Release Commit Uses --no-verify:**

This is SAFE because the release script validates BEFORE committing:

| Check | Run By Release Script | Would Pre-commit Run Again |
|-------|----------------------|---------------------------|
| Linting (ESLint) | ✅ Yes | ✅ Redundant |
| Type checking | ✅ Yes | ✅ Redundant |
| Tests | ✅ Yes | ✅ Redundant (+ flaky risk) |
| Formatting | ✅ Yes | ✅ Redundant |
| Security scan | ✅ Yes | ❌ Not in pre-commit |

### Workflow Version Consistency Validation

**RELIABILITY: BUN_VERSION and NODE_VERSION must match across workflows**

The release script validates that tool versions are consistent between
`ci.yml` and `publish.yml` workflows.

**Historical Bug (Fixed in commit 1474f3f, 6bd2c8f):**

The publish workflow had `BUN_VERSION: 1.1.42` while CI used `1.3.5`. The bun
lockfile format changed between versions, causing publish to fail with
"Unknown lockfile version" error.

```
error: Unknown lockfile version
    at bun.lock:2:22
InvalidLockfileVersion: failed to parse lockfile: 'bun.lock'
```

**Safeguards Implemented (Issue 8 & 9 in validate_ci_workflows):**

1. **BUN_VERSION mismatch detection:**
   - Compares BUN_VERSION in ci.yml vs publish.yml
   - Reports exact versions found
   - Provides sed command to fix

2. **NODE_VERSION mismatch detection:**
   - Compares NODE_VERSION in ci.yml vs publish.yml
   - Important because npm OIDC requires Node.js 24+

**Run validation manually:**

```bash
./scripts/release.sh --check
```

### Post-Publish Verification with Bun

**RELIABILITY: Verify package works with both npm and bun**

The release script now runs two verification phases after npm publication:

1. **npm verification** (verify_post_publish_installation):
   - Tests `npm install pkg@version`
   - Tests `require('svg-bbox')`
   - Tests all 13 CLI tools with --help

2. **bun verification** (verify_bun_installation):
   - Tests `bun add pkg@version`
   - Tests `require('svg-bbox')` with bun runtime
   - Runs actual CLI commands (sbb-getbbox on test SVG)
   - Tests sbb-extract and sbb-compare --help

**Why both verifications:**

- Users install with both npm and bun
- Bun handles dependencies differently than npm
- Actual CLI execution catches more issues than --help

### Changelog Auto-Update

**CHANGELOG: Automatic changelog generation with git-cliff**

The release script automatically updates CHANGELOG.md at every release using
git-cliff. This ensures the changelog is always current and matches the release.

**How it works:**

1. `update_changelog()` is called AFTER `generate_release_notes()` but BEFORE
   `commit_version_bump()`
2. Uses `git-cliff --tag "vX.Y.Z" -o CHANGELOG.md` to regenerate the full changelog
3. The changelog is included in the version bump commit

**Validation and error handling:**

- VERSION parameter is validated (empty check, ANSI stripping, semver format)
- File permissions are checked before write
- Verifies CHANGELOG.md was created and is non-empty
- Verifies the new version appears in the generated changelog
- Shows git-cliff warnings for debugging (e.g., non-conventional commits)
- Falls back to `git-cliff -o CHANGELOG.md` if --tag fails

**Configuration:**

- `cliff.toml` - git-cliff configuration file (optional but recommended)
- Uses Keep a Changelog format
- Follows Semantic Versioning
- Groups commits by type (feat, fix, docs, etc.)

**Manual changelog update:**

If needed outside of releases:

```bash
# Regenerate full changelog
git-cliff -o CHANGELOG.md

# Preview without writing
git-cliff

# Include unreleased commits for a future version
git-cliff --tag "v1.2.0" -o CHANGELOG.md
```

**Non-fatal behavior:**

Changelog update failures are logged but don't block the release. This is
intentional because:

- git-cliff might not be installed
- cliff.toml might be missing
- Some commits might not follow conventional format (warnings only)

The release will proceed with the existing CHANGELOG.md if update fails.

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
- **bun** for fast dependency management (preferred over pnpm)
- **npm trusted publishing** for releases (Node.js 24 required)
- Tests run in parallel for speed

### Development Notes

- Font rendering tolerance set to 4px (cross-platform differences)
- Integration tests use temp directories to avoid polluting project root
- SVG comparison tool has configurable thresholds and alignment modes

---

## Codebase Audit Method (Agent Swarm Pattern)

**ALWAYS use this method for comprehensive codebase audits.**

This approach uses a swarm of parallel agents to audit every file in the codebase, ensuring thorough coverage and consistent quality checks.

### When to Use

- Before major releases
- After significant refactoring
- When inheriting/reviewing a codebase
- Periodic quality assurance checks

### Audit Procedure

#### Step 1: Create Timestamped Audit Directory

```bash
# Create directory with timestamp in docs_dev/
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p docs_dev/audit_reports_${TIMESTAMP}
```

#### Step 2: Identify All Files to Audit

Audit these file categories:
- **Source files**: `*.cjs`, `*.js`, `*.mjs`, `*.ts`
- **Library files**: `lib/*.cjs`
- **Config files**: `*.config.js`, `config/*.cjs`
- **Documentation**: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `API.md`, `SECURITY.md`
- **Build scripts**: `scripts/*.cjs`, `scripts/*.js`, `build.js`
- **Test files**: `tests/**/*.test.js`
- **Example files**: `examples/*.html`, `examples/*.js`

#### Step 3: Spawn Parallel Agents (One Per File)

Use the Task tool to spawn up to 40 agents in parallel. Each agent:
- Reads exactly ONE file
- Applies the standardized audit checklist
- Outputs a report to `audit_<filename>.md`

**Agent Prompt Template:**

```
Audit the file: <FILE_PATH>

Check for:
1. ERRORS & BUGS: Logic errors, uncaught exceptions, edge cases
2. OUTDATED COMMENTS: Comments that don't match current code
3. INCOMPLETE JSDOC: Missing @param, @returns, @throws, @example
4. REDUNDANT CODE: Dead code, unused imports, duplicate logic
5. HELP SCREEN ACCURACY: CLI help text matches actual behavior
6. SECURITY ISSUES: Injection risks, unsafe operations
7. VERSION CONSISTENCY: All version references match package.json
8. CODE QUALITY: Style, naming, complexity issues

Classify issues as:
- CRITICAL: Must fix immediately (security, crashes, data loss)
- MAJOR: Should fix before release (bugs, incorrect behavior)
- MINOR: Nice to fix (style, documentation, minor improvements)

Output a report to: docs_dev/audit_reports_<TIMESTAMP>/audit_<filename>.md

Report format:
# Audit Report: <filename>
## Summary
[1-2 sentence summary]
## Issues Found
### CRITICAL
[List or "None"]
### MAJOR
[List with line numbers]
### MINOR
[List with line numbers]
## Recommendations
[Prioritized action items]
```

#### Step 4: Collect Reports and Create Master Summary

After all agents complete, create `AUDIT_MASTER_SUMMARY.md`:
- Executive summary with issue counts
- Issues organized by severity (CRITICAL → MAJOR → MINOR)
- Files organized by assessment (Excellent → Good → Needs Attention)
- Fix priority order
- Audit methodology documentation

#### Step 5: Fix Issues in Priority Order

1. **Phase 1 - CRITICAL**: Fix immediately (security, crashes)
2. **Phase 2 - MAJOR**: Fix before release (bugs, incorrect behavior)
3. **Phase 3 - MINOR**: Fix as time allows (documentation, style)

### Audit Checklist Reference

| Category | What to Check |
|----------|---------------|
| **Errors** | Null/undefined access, type mismatches, boundary conditions |
| **Comments** | Match code behavior, no TODO/FIXME left behind |
| **JSDoc** | All public functions documented with @param, @returns |
| **Imports** | No unused imports, correct paths |
| **Help Text** | Matches actual CLI behavior, correct examples |
| **Security** | Input validation, no injection risks, safe file ops |
| **Versions** | All references match package.json version |
| **Deprecated** | No deprecated APIs (substr→slice, etc.) |

### Example Audit Session

```bash
# 1. Created audit directory
docs_dev/audit_reports_20260101_222054/

# 2. Spawned 40 agents for all files

# 3. Collected results:
- 2 CRITICAL issues (README version mismatch, path resolution bug)
- 12 MAJOR issues (bugs, outdated references, deprecated APIs)
- 15+ MINOR issues (missing JSDoc, unused imports)

# 4. Fixed in order:
- CRITICAL: README Node.js version ≥18 → ≥24
- CRITICAL: svg-bbox.cjs path resolution for npm install
- MAJOR: wrapError() context preservation
- MAJOR: sbb-extract.cjs outdated filename references
- MAJOR: sbb-compare.cjs deprecated substr() → slice()
- MINOR: SvgVisualBBox.js NaN validation
- MINOR: Missing JSDoc annotations
- MINOR: TTY check for interactive mode
```

### Benefits of Agent Swarm Pattern

1. **Parallel execution**: 40 files audited simultaneously
2. **Consistent checks**: Same checklist applied to every file
3. **Complete coverage**: No file missed
4. **Traceable results**: Timestamped reports for reference
5. **Prioritized fixes**: CRITICAL → MAJOR → MINOR order
6. **Documentation**: Audit methodology preserved for future use
