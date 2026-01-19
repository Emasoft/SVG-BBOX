# Development Pipeline Documentation

A comprehensive guide to building error-proof CI/CD pipelines. This document
covers the foundational principles and rules first, followed by practical
implementations for single-package and monorepo projects across multiple
languages.

---

## Table of Contents

**Part I: Principles & Rules**

1. [Core Philosophy](#core-philosophy)
2. [The Ten Commandments of Error-Proof Pipelines](#the-ten-commandments-of-error-proof-pipelines)
3. [The Two-Stage Commit/Push Model](#the-two-stage-commitpush-model)
4. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

**Part II: Implementation** 5.
[Pipeline Architecture](#pipeline-architecture) 6.
[Current Implementation (svg-bbox)](#current-implementation-svg-bbox) 7.
[Monorepo Patterns](#monorepo-patterns) 8.
[Language-Specific Configurations](#language-specific-configurations) 9.
[Troubleshooting Guide](#troubleshooting-guide) 10.
[Quick Reference](#quick-reference)

---

# Part I: Principles & Rules

---

## Core Philosophy

### The Golden Rule: "Commit Early, Commit Often, Push When Ready"

This principle is the foundation of an effective development workflow:

| Action     | Purpose             | Mental Model                      |
| ---------- | ------------------- | --------------------------------- |
| **Commit** | Personal save point | "I might want to undo this"       |
| **Push**   | Share with team     | "This is ready for others to see" |

**Why commits must be fast:**

1. **Safety net for experiments** - Before trying a risky refactor, you commit.
   If the commit takes 2 minutes, you'll skip it and risk losing work.

2. **Atomic work units** - Small, frequent commits create a readable history.
   Slow commits encourage giant, monolithic commits.

3. **Emergency escapes** - When you realize you're going down the wrong path,
   you need to commit immediately so you can revert. Tests shouldn't block this.

**Why pushes must be comprehensive:**

1. **Quality gate** - Code reaching the remote repository represents your work
   to others.

2. **CI efficiency** - Catching errors locally saves CI minutes and avoids the
   "red main branch" problem.

3. **Team trust** - When you push, others should trust they can pull without
   breaking their environment.

### The Pipeline Pyramid

```
                    ┌────────────┐
                    │   Deploy   │  ← Production release (minutes)
                   ┌┴────────────┴┐
                   │   Publish    │  ← Package registry (2-5 min)
                  ┌┴──────────────┴┐
                  │   Release CI   │  ← Pre-publish validation (5-10 min)
                 ┌┴────────────────┴┐
                 │    Main CI       │  ← Full test suite (10-15 min)
                ┌┴──────────────────┴┐
                │     Pre-push       │  ← Local comprehensive checks (2-5 min)
               ┌┴────────────────────┴┐
               │     Pre-commit       │  ← Fast format/lint (< 5 sec)
              ┌┴──────────────────────┴┐
              │       IDE/Editor       │  ← Real-time feedback
              └────────────────────────┘
```

**Each layer has a specific purpose:**

| Layer      | What It Catches         | Why Not Earlier           | Why Not Later                |
| ---------- | ----------------------- | ------------------------- | ---------------------------- |
| IDE/Editor | Syntax errors           | -                         | Too slow                     |
| Pre-commit | Formatting issues       | Would slow IDE            | Formatting is trivial to fix |
| Pre-push   | Logic/type/test errors  | Would slow commits        | Would waste CI time          |
| Main CI    | Integration issues      | Would slow push           | Would reach production       |
| Release CI | Security/version issues | Only needed at release    | Would block release          |
| Publish    | Registry validation     | Only relevant for publish | -                            |

---

## The Ten Commandments of Error-Proof Pipelines

### 1. Fail Fast, Fail Clearly

**Rule:** Run fast checks first. Stop on first category of failure. Show
actionable error messages.

**Rationale:** Time wasted on later checks when early checks would fail is time
lost. Every failure message should tell the developer exactly what's wrong and
how to fix it.

```sh
# CORRECT: Stop after lint fails, show fix command
bun run lint || {
    echo "Lint failed. Run 'bun run lint:fix' to auto-fix."
    exit 1
}
bun run typecheck || exit 1
bun run test || exit 1

# WRONG: Run everything, report at end
FAILED=0
bun run lint || FAILED=1
bun run typecheck || FAILED=1
bun run test || FAILED=1  # Wasted 2 minutes when lint failed in 5 seconds
exit $FAILED
```

**Exception:** Within a test suite, show all failures (not just the first):

```javascript
// vitest.config.js
bail: 0; // Show ALL test failures to aid debugging
```

### 2. Idempotency

**Rule:** Running the same command twice must produce the same result.

**Rationale:** Pipelines retry. Networks fail. Processes get killed. If a
command isn't idempotent, retries cause inconsistent states.

```sh
# CORRECT: Idempotent version bump
npm version patch --no-git-tag-version
# First run: 1.0.0 → 1.0.1
# If interrupted and re-run: 1.0.1 → 1.0.2 (expected behavior)

# CORRECT: Idempotent tag deletion
git tag -d v1.0.1 2>/dev/null || true  # Succeeds whether tag exists or not

# WRONG: Non-idempotent file creation
echo "1.0.1" > version.txt
git add version.txt
# Second run creates duplicate git add, no version bump
```

### 3. Atomicity

**Rule:** Operations must either fully succeed or fully fail. Partial states are
bugs.

**Rationale:** A tag without a release, a release without a publish, a publish
without verification - these create confusion and broken states.

```sh
# CORRECT: Atomic release creation (gh CLI pushes tag + creates release together)
gh release create v1.0.1 --target "$COMMIT_SHA" --title "v1.0.1" --notes "..."
# Tag and release exist together or neither exists

# WRONG: Non-atomic (race condition)
git push origin v1.0.1           # Tag pushed, triggers workflow
sleep 5
gh release create v1.0.1 ...     # Workflow might finish before release exists
```

### 4. Rollback Capability

**Rule:** Track every state change. Enable cleanup on failure.

**Rationale:** When step 7 of 10 fails, you need to undo steps 1-6. Without
tracking, you can't know what to undo.

```sh
# State tracking
TAG_CREATED=false
COMMITS_PUSHED=false
RELEASE_CREATED=false

create_tag() {
    git tag -a "v$VERSION" -m "Release $VERSION"
    TAG_CREATED=true
}

rollback() {
    if [ "$TAG_CREATED" = true ]; then
        git tag -d "v$VERSION" 2>/dev/null || true
    fi
    if [ "$COMMITS_PUSHED" = true ]; then
        echo "WARNING: Commits pushed. Manual rollback required."
    fi
}

trap rollback EXIT
```

### 5. Version Consistency

**Rule:** Tool versions must be identical across all pipeline stages.

**Rationale:** A test passing locally with Node 22 but failing in CI with Node
20 wastes hours of debugging. Different Bun versions produce incompatible
lockfiles.

```yaml
# CORRECT: Single source of truth
# ci.yml
env:
  NODE_VERSION: '24'
  BUN_VERSION: '1.3.5'

# publish.yml
env:
  NODE_VERSION: '24'      # MUST match ci.yml
  BUN_VERSION: '1.3.5'    # MUST match ci.yml

# WRONG: Hardcoded, divergent versions
# ci.yml
- uses: setup-node@v4
  with:
    node-version: '20'    # Different from publish.yml

# publish.yml
- uses: setup-node@v4
  with:
    node-version: '22'    # npm OIDC needs 24+, CI used 20
```

### 6. No Silent Failures

**Rule:** Every failure must be visible, logged, and actionable.

**Rationale:** `|| true` hides critical errors. Suppressed output hides
diagnostic information.

```sh
# CORRECT: Visible failure with fix instructions
if ! npm audit --audit-level=high; then
    echo "Security vulnerabilities found!"
    echo "Run 'npm audit fix' to attempt automatic fixes."
    echo "See above for specific vulnerabilities."
    exit 1
fi

# WRONG: Silent failure
npm audit 2>/dev/null || true  # Security issues hidden

# WRONG: Suppressed diagnostics
bun run test > /dev/null 2>&1 || exit 1  # No way to debug failures
```

### 7. Validate Before Action

**Rule:** Check all preconditions before making any changes.

**Rationale:** Finding out you're on the wrong branch AFTER bumping the version
creates unnecessary cleanup work.

```sh
# CORRECT: All validations first, then actions
validate_environment() {
    command -v gh >/dev/null || { echo "gh CLI required"; exit 1; }
    command -v bun >/dev/null || { echo "bun required"; exit 1; }
}

validate_git_state() {
    [ -z "$(git status --porcelain)" ] || { echo "Uncommitted changes"; exit 1; }
    [ "$(git branch --show-current)" = "main" ] || { echo "Not on main"; exit 1; }
}

validate_tests() {
    bun run test || { echo "Tests failed"; exit 1; }
}

# Run ALL validations BEFORE any changes
validate_environment
validate_git_state
validate_tests

# Only now make changes
bump_version
create_release
```

### 8. Explicit Over Implicit

**Rule:** Make dependencies and requirements explicit. No magic.

**Rationale:** Implicit ordering breaks when refactored. Implicit dependencies
are forgotten.

```yaml
# CORRECT: Explicit job dependencies
jobs:
  lint:
    runs-on: ubuntu-latest
  typecheck:
    runs-on: ubuntu-latest
  test:
    needs: [lint, typecheck]  # Explicit: test only runs if both pass
    runs-on: ubuntu-latest

# WRONG: Implicit (unreliable)
jobs:
  a-lint:      # Relies on alphabetical ordering
  b-typecheck:
  c-test:      # Might run before a and b!
```

### 9. Concurrency Control

**Rule:** Prevent concurrent execution of conflicting operations.

**Rationale:** Two pre-push hooks running simultaneously can corrupt state. Two
CI runs can create race conditions.

```sh
# Local: File locking
LOCK_FILE="/tmp/project-pre-push.lock"
exec 200>"$LOCK_FILE"
flock -n 200 || {
    echo "Another hook is running. Waiting..."
    flock -w 600 200 || exit 1
}
```

```yaml
# CI: Concurrency groups
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true # New push cancels old run
```

### 10. Documentation as Code

**Rule:** Pipeline behavior must be documented in the code itself.

**Rationale:** External documentation gets outdated. Inline comments stay with
the code.

```sh
# CORRECT: Self-documenting
# ============================================================================
# Pre-push hook: COMPREHENSIVE validation before code reaches remote
#
# PURPOSE: Catch ALL issues locally before wasting CI time
# CHECKS:  Lint → Typecheck → Security → Build → Tests
# TIME:    2-5 minutes (acceptable for push, not for commit)
# BYPASS:  git push --no-verify (use only for emergencies)
# ============================================================================

# WRONG: Magic incantation
npm run ci && npm run e2e  # What does this do? When? Why?
```

---

## The Two-Stage Commit/Push Model

### Stage 1: Pre-Commit (Lightweight)

**Time budget:** < 5 seconds

**Purpose:** Keep code formatted consistently without blocking workflow.

**Allowed operations:**

- Auto-format (Prettier, Black, rustfmt, gofmt)
- Auto-fix simple lint issues (ESLint --fix, ruff --fix)
- Re-stage formatted files

**Forbidden operations:**

- Tests (too slow)
- Type checking (can fail for WIP code)
- Build (unnecessary for commits)
- Security scans (run at push)
- Network requests (slow, flaky)

### Stage 2: Pre-Push (Comprehensive)

**Time budget:** 2-5 minutes

**Purpose:** Ensure code is ready for others to see.

**Required operations:**

1. **Lint** (check, not fix) - Code must pass as-is
2. **Type check** - Catch type errors before CI
3. **Security audit** - High/critical vulnerabilities block
4. **Build** - Ensure build succeeds
5. **Full test suite** - All tests must pass

**Order matters:** Fast checks first (lint: 5s) before slow checks (tests:
2min).

### Why This Split Works

| Scenario                   | Pre-commit Only | Pre-push Only           | Both (Correct) |
| -------------------------- | --------------- | ----------------------- | -------------- |
| Quick save before refactor | 5s wait         | 5min wait               | 5s wait        |
| Share finished feature     | Tests skip      | 5min wait               | 5min wait      |
| Format consistency         | ✓               | ✗ (push-time surprises) | ✓              |
| Catch bugs early           | ✗               | ✓                       | ✓              |

---

## Anti-Patterns to Avoid

### 1. Tests in Pre-Commit

**Problem:** Blocks quick commits, encourages `--no-verify` habit.

```sh
# WRONG
pre-commit:
  - bun run test  # 2+ minute wait for every commit

# RIGHT
pre-commit:
  - bun run lint:fix  # < 5 seconds
pre-push:
  - bun run test  # Comprehensive check before push
```

### 2. Non-Deterministic Tests

**Problem:** Random failures erode trust in the pipeline.

```javascript
// WRONG: Timing-dependent
it('completes quickly', async () => {
  const start = Date.now();
  await heavyOperation();
  expect(Date.now() - start).toBeLessThan(100); // Fails on slow CI
});

// RIGHT: Outcome-dependent
it('completes successfully', async () => {
  const result = await heavyOperation();
  expect(result.status).toBe('success');
});
```

### 3. Silent Test Skips

**Problem:** Skipped tests hide regressions.

```javascript
// WRONG: Hidden skip
it.skip('broken test', () => {}); // Forgotten, never fixed

// RIGHT: Conditional with reason
it.skipIf(!process.env.CI, 'requires CI environment: needs Redis');
```

### 4. Capturing Polluted Output

**Problem:** Command output can contain ANSI codes, lifecycle hook output,
verbose logs.

```sh
# WRONG: npm output includes lifecycle hooks, color codes
VERSION=$(npm version patch)  # "✓ Version bumped...\n1.0.1"

# RIGHT: Read from source of truth after command succeeds
npm version patch >/dev/null 2>&1 || exit 1
VERSION=$(node -p "require('./package.json').version")
```

### 5. Manual Multi-Step Releases

**Problem:** Human error in step 3 of 10 creates inconsistent states.

```sh
# WRONG: Manual steps
npm version patch
git push
git push --tags
npm publish
# Did you run tests? Update changelog? Create GitHub release?

# RIGHT: Automated pipeline
./scripts/release.sh patch  # Does everything, or nothing
```

### 6. Divergent Tool Versions

**Problem:** "Works on my machine" syndrome.

```yaml
# WRONG: Different versions
# ci.yml:      node-version: '20'
# publish.yml: node-version: '22'
# local:       node-version: '18'

# RIGHT: Centralized, enforced
env:
  NODE_VERSION: '24' # Single source of truth
```

### 7. Ignoring Exit Codes

**Problem:** Failures are hidden.

```sh
# WRONG: Silent failure
npm audit || true  # Security issues? Who cares!

# RIGHT: Explicit handling
npm audit --audit-level=high || {
    echo "Security vulnerabilities found. See above."
    exit 1
}
```

### 8. Race Conditions in Releases

**Problem:** Workflow triggers before release exists.

```sh
# WRONG: Non-atomic
git push origin v1.0.1        # Triggers publish workflow
gh release create v1.0.1 ...  # Workflow might finish first!

# RIGHT: Atomic via gh CLI
gh release create v1.0.1 --target "$SHA" ...
# gh pushes tag AND creates release atomically
```

---

# Part II: Implementation

---

## Pipeline Architecture

### Stage Model

```
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 1: Fast Checks (parallel, < 2 min)                         │
│ ┌─────────┐   ┌────────────┐   ┌───────────┐                     │
│ │  Lint   │   │ Type Check │   │   Build   │                     │
│ └────┬────┘   └──────┬─────┘   └─────┬─────┘                     │
│      └───────────────┴───────────────┘                           │
└──────────────────────────┬───────────────────────────────────────┘
                           │ All must pass
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 2: Tests (parallel by type, < 10 min)                      │
│ ┌──────────────────┐   ┌──────────────────────────────────────┐  │
│ │ Unit/Integration │   │ E2E (ubuntu, macos, windows)         │  │
│ └────────┬─────────┘   └──────────────────┬───────────────────┘  │
│          └────────────────────────────────┘                      │
└──────────────────────────┬───────────────────────────────────────┘
                           │ All must pass
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 3: Coverage & Reports (< 5 min)                            │
│ ┌─────────────────┐   ┌────────────────────┐                     │
│ │ Coverage Report │   │ Upload to Codecov  │                     │
│ └─────────────────┘   └────────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

### Why Stages?

1. **Resource efficiency** - Don't run 30-minute test suite if 5-second lint
   fails
2. **Feedback speed** - Developer learns of lint failure in 2 min, not 30 min
3. **Cost savings** - Parallel E2E tests are expensive; only run if code is
   valid

---

## Current Implementation (svg-bbox)

### File Structure

```
.git/hooks/
├── pre-commit          # Lightweight: format/lint only (< 5s)
└── pre-push            # Comprehensive: lint, typecheck, security, build, tests (2-5 min)

.github/workflows/
├── ci.yml              # Main CI: triggered on push/PR to main/develop
└── publish.yml         # Release: triggered by v* tag push

scripts/
├── release.sh          # Unified release automation (40+ validators)
├── test-selective.cjs  # Smart test selection based on changed files
└── hooks/              # Hook templates for distribution
```

### Pre-Commit Hook

```sh
#!/bin/sh
# Pre-commit hook: LIGHTWEIGHT checks only
# Time budget: < 5 seconds
# Principle: "Commits should be friction-free save points"

set -e

# Auto-format and auto-fix
bun run lint:fix

# Re-stage formatted files
git diff --cached --name-only --diff-filter=ACM | while read file; do
    [ -f "$file" ] && git add "$file"
done
```

### Pre-Push Hook

```sh
#!/bin/sh
# Pre-push hook: COMPREHENSIVE checks
# Time budget: 2-5 minutes
# Principle: "Code reaching remote must pass ALL quality gates"

set -e

# Fast checks first (fail early)
bun run lint || { echo "Lint failed"; exit 1; }
bun run typecheck || { echo "Typecheck failed"; exit 1; }

# Security (high/critical only)
npm audit --audit-level=high || { echo "Security audit failed"; exit 1; }

# Build validation
bun run build || { echo "Build failed"; exit 1; }

# Full test suite (slowest, run last)
bun run test || { echo "Tests failed"; exit 1; }
```

### CI Workflow (ci.yml)

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  NODE_VERSION: '24'
  BUN_VERSION: '1.3.5'

jobs:
  # STAGE 1: Fast checks (parallel)
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - run: bun install --frozen-lockfile
      - run: bun run build

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - run: bun install --frozen-lockfile
      - run: bun run lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck

  # STAGE 2: Tests (after fast checks pass)
  test:
    needs: [build, lint, typecheck]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - run: bun install --frozen-lockfile
      - run: bun run test
```

### Publish Workflow (publish.yml)

```yaml
name: Publish to npm

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write # Required for npm OIDC

env:
  NODE_VERSION: '24' # MUST match ci.yml
  BUN_VERSION: '1.3.5' # MUST match ci.yml

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}' }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '${{ env.BUN_VERSION }}' }
      - run: bun install --frozen-lockfile

      # Pre-publish validation (safety net)
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test

      # Publish with OIDC (no NPM_TOKEN needed)
      - run: npm publish --access public
```

### Release Script Integration

The release script (`scripts/release.sh`) orchestrates the full release:

1. **Validation phase** - 40+ checks before any changes
2. **Bump phase** - Version in package.json
3. **Changelog phase** - Auto-generated with git-cliff
4. **Commit phase** - Version + changelog committed
5. **Tag phase** - Created locally (not pushed yet)
6. **Push phase** - Commits pushed, CI runs
7. **Wait phase** - CI must pass before release
8. **Release phase** - GitHub Release created (pushes tag atomically)
9. **Verify phase** - npm publication confirmed

```sh
# Usage
./scripts/release.sh patch   # 1.0.10 → 1.0.11
./scripts/release.sh minor   # 1.0.10 → 1.1.0
./scripts/release.sh major   # 1.0.10 → 2.0.0
./scripts/release.sh --yes patch  # Skip confirmation (CI use)
```

---

## Monorepo Patterns

### Directory Structure

```
monorepo/
├── .github/workflows/
│   ├── ci.yml              # Orchestrates per-package CI
│   └── release.yml         # Handles multi-package releases
├── packages/
│   ├── core/               # @myorg/core (TypeScript)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   ├── cli/                # @myorg/cli (Node.js)
│   │   └── package.json
│   └── ui/                 # @myorg/ui (React)
│       └── package.json
├── apps/
│   ├── web/                # Next.js application
│   └── api/                # Express/Fastify API
├── package.json            # Workspace root
├── turbo.json              # Build orchestration
└── bun.lockb               # Single lockfile
```

### Change Detection

Only test packages that changed:

```yaml
jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      core: ${{ steps.filter.outputs.core }}
      cli: ${{ steps.filter.outputs.cli }}
      ui: ${{ steps.filter.outputs.ui }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v2
        id: filter
        with:
          filters: |
            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'
            ui:
              - 'packages/ui/**'

  test-core:
    needs: detect-changes
    if: needs.detect-changes.outputs.core == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: cd packages/core && bun test
```

### Dependency-Aware Builds

```json
// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"], // Build dependencies first
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"], // Test after build
      "inputs": ["src/**", "tests/**"]
    },
    "lint": {
      "inputs": ["src/**"] // No dependencies
    }
  }
}
```

### Monorepo Pre-Push Hook

```sh
#!/bin/sh
# Monorepo-aware pre-push hook

set -e

# Detect changed packages
CHANGED=$(git diff --name-only HEAD~1 | grep -E "^packages/" | cut -d/ -f2 | sort -u)

if [ -z "$CHANGED" ]; then
    echo "No package changes"
    exit 0
fi

echo "Changed packages: $CHANGED"

for pkg in $CHANGED; do
    echo "Checking packages/$pkg..."
    cd "packages/$pkg"

    # Detect language and run appropriate checks
    if [ -f "package.json" ]; then
        bun run lint && bun run typecheck && bun run test
    elif [ -f "Cargo.toml" ]; then
        cargo fmt --check && cargo clippy && cargo test
    elif [ -f "pyproject.toml" ]; then
        ruff check && mypy . && pytest
    fi

    cd ../..
done
```

---

## Language-Specific Configurations

### JavaScript/TypeScript (Bun/Node.js)

| Stage     | Command                          | Tool              |
| --------- | -------------------------------- | ----------------- |
| Format    | `prettier --write .`             | Prettier          |
| Lint      | `eslint . && prettier --check .` | ESLint + Prettier |
| Typecheck | `tsc --noEmit`                   | TypeScript        |
| Test      | `vitest run`                     | Vitest            |
| Build     | `bun run build.js`               | Custom/esbuild    |
| Security  | `npm audit --audit-level=high`   | npm               |

### Python (uv/pip)

| Stage     | Command           | Tool      |
| --------- | ----------------- | --------- |
| Format    | `ruff format .`   | Ruff      |
| Lint      | `ruff check .`    | Ruff      |
| Typecheck | `mypy . --strict` | mypy      |
| Test      | `pytest`          | pytest    |
| Build     | `python -m build` | build     |
| Security  | `pip-audit`       | pip-audit |

### Rust (Cargo)

| Stage    | Command                       | Tool        |
| -------- | ----------------------------- | ----------- |
| Format   | `cargo fmt`                   | rustfmt     |
| Lint     | `cargo clippy -- -D warnings` | Clippy      |
| Test     | `cargo test`                  | Cargo       |
| Build    | `cargo build --release`       | Cargo       |
| Security | `cargo audit`                 | cargo-audit |

### Go

| Stage    | Command             | Tool          |
| -------- | ------------------- | ------------- |
| Format   | `gofmt -w .`        | gofmt         |
| Lint     | `golangci-lint run` | golangci-lint |
| Test     | `go test ./...`     | Go            |
| Build    | `go build -o dist/` | Go            |
| Security | `govulncheck ./...` | govulncheck   |

### Swift (iOS/macOS)

| Stage  | Command                        | Tool        |
| ------ | ------------------------------ | ----------- |
| Format | `swiftformat .`                | SwiftFormat |
| Lint   | `swiftlint --strict`           | SwiftLint   |
| Test   | `xcodebuild test -scheme App`  | Xcode       |
| Build  | `xcodebuild build -scheme App` | Xcode       |

### C++

| Stage  | Command                    | Tool         |
| ------ | -------------------------- | ------------ |
| Format | `clang-format -i **/*.cpp` | clang-format |
| Lint   | `cppcheck --enable=all .`  | cppcheck     |
| Test   | `ctest --test-dir build`   | CTest        |
| Build  | `cmake --build build`      | CMake        |

### Java (Gradle)

| Stage    | Command                            | Tool     |
| -------- | ---------------------------------- | -------- |
| Format   | `./gradlew spotlessApply`          | Spotless |
| Lint     | `./gradlew spotlessCheck`          | Spotless |
| Test     | `./gradlew test`                   | Gradle   |
| Build    | `./gradlew build`                  | Gradle   |
| Security | `./gradlew dependencyCheckAnalyze` | OWASP    |

### Ruby

| Stage    | Command               | Tool          |
| -------- | --------------------- | ------------- |
| Format   | `rubocop -a`          | RuboCop       |
| Lint     | `rubocop`             | RuboCop       |
| Test     | `bundle exec rspec`   | RSpec         |
| Build    | `gem build *.gemspec` | gem           |
| Security | `bundle-audit check`  | bundler-audit |

### C# (.NET)

| Stage    | Command                             | Tool   |
| -------- | ----------------------------------- | ------ |
| Format   | `dotnet format`                     | dotnet |
| Lint     | `dotnet format --verify-no-changes` | dotnet |
| Test     | `dotnet test`                       | dotnet |
| Build    | `dotnet build -c Release`           | dotnet |
| Security | `dotnet list package --vulnerable`  | dotnet |

### React Native

| Stage   | Command                    | Tool        |
| ------- | -------------------------- | ----------- |
| Format  | `prettier --write .`       | Prettier    |
| Lint    | `eslint . && tsc --noEmit` | ESLint + TS |
| Test    | `jest`                     | Jest        |
| iOS     | `xcodebuild -scheme App`   | Xcode       |
| Android | `./gradlew assembleDebug`  | Gradle      |

### Electron

| Stage     | Command                  | Tool             |
| --------- | ------------------------ | ---------------- |
| Format    | `prettier --write .`     | Prettier         |
| Lint      | `eslint .`               | ESLint           |
| Typecheck | `tsc --noEmit`           | TypeScript       |
| Test      | `vitest run`             | Vitest           |
| Build     | `electron-builder --dir` | electron-builder |

### Unity (C#)

| Stage  | Command                             | Tool   |
| ------ | ----------------------------------- | ------ |
| Format | `dotnet format`                     | dotnet |
| Lint   | `dotnet format --verify-no-changes` | dotnet |
| Test   | `Unity -batchmode -runTests`        | Unity  |
| Build  | `Unity -batchmode -buildTarget`     | Unity  |

---

## Troubleshooting Guide

### Pre-push takes too long (> 5 min)

**Symptoms:** Developers bypass with `--no-verify`

**Solutions:**

1. Run fast checks first (lint 5s, typecheck 10s before tests 2min)
2. Use selective testing based on changed files
3. Cache dependencies between runs
4. Parallelize independent checks

### "Works locally, fails in CI"

**Symptoms:** Tests pass on developer machine but fail in CI

**Solutions:**

1. Pin exact tool versions (NODE_VERSION, BUN_VERSION)
2. Use `--frozen-lockfile` in CI
3. Document system requirements
4. Check for OS-specific code paths

### Flaky tests

**Symptoms:** Tests pass/fail randomly

**Solutions:**

1. Remove timing-dependent assertions
2. Use proper async/await (no arbitrary sleeps)
3. Isolate tests (no shared state)
4. Add retry logic ONLY for external service tests
5. Set `bail: 0` to see all failures

### Security audit blocks release

**Symptoms:** `npm audit` finds vulnerabilities

**Solutions:**

1. `npm audit fix` for compatible updates
2. `npm audit fix --force` for major updates (test thoroughly)
3. Add `overrides` in package.json for false positives
4. Use `--audit-level=high` to ignore moderate/low

### Tag exists but release failed

**Symptoms:** v1.0.1 tag on GitHub but no release/npm package

**Solutions:**

```sh
# Delete tag locally
git tag -d v1.0.1

# Delete tag remotely
git push origin :v1.0.1

# Fix the issue, then re-run release
./scripts/release.sh patch
```

### Version mismatch between workflows

**Symptoms:** "Unknown lockfile version" or OIDC failures

**Solutions:**

1. Ensure NODE_VERSION matches in ci.yml and publish.yml
2. Ensure BUN_VERSION matches in ci.yml and publish.yml
3. Regenerate lockfile: `rm bun.lockb && bun install`
4. npm OIDC requires Node.js 24+ (npm 11.5.1+)

---

## Quick Reference

### Git Hooks

| Hook       | Purpose       | Time | Checks                                 |
| ---------- | ------------- | ---- | -------------------------------------- |
| pre-commit | Format code   | < 5s | lint:fix, format                       |
| pre-push   | Validate code | < 5m | lint, typecheck, security, build, test |

### CI Stages

| Stage | Jobs                   | Runs When      |
| ----- | ---------------------- | -------------- |
| 1     | lint, typecheck, build | Always         |
| 2     | test, e2e              | Stage 1 passes |
| 3     | coverage               | Stage 2 passes |

### Release Checklist

1. ✓ Validate environment (gh, npm, bun installed)
2. ✓ Validate git state (clean, on main, synced)
3. ✓ Run quality checks (lint, typecheck, tests)
4. ✓ Bump version in package.json
5. ✓ Generate changelog
6. ✓ Commit changes
7. ✓ Create tag locally
8. ✓ Push commits (not tag)
9. ✓ Wait for CI to pass
10. ✓ Create GitHub Release (pushes tag)
11. ✓ Wait for publish workflow
12. ✓ Verify npm publication

### Bypass Commands (Emergency Only)

```sh
# Skip pre-commit (format only - low risk)
git commit --no-verify -m "WIP: emergency"

# Skip pre-push (USE WITH CAUTION)
git push --no-verify

# Force push (DANGEROUS - requires approval)
git push --force-with-lease origin branch
```

---

## Summary

An error-proof pipeline follows these principles:

1. **Fast commits, comprehensive pushes** - Two-stage model respects developer
   flow
2. **Fail fast, fail clearly** - Early stops with actionable messages
3. **Idempotency and atomicity** - Repeatable, all-or-nothing operations
4. **Version consistency** - Same tools everywhere, always
5. **No silent failures** - Every error visible and logged
6. **Validate before action** - Check preconditions first
7. **Explicit dependencies** - No implicit ordering or magic
8. **Concurrency control** - Prevent conflicting operations
9. **Rollback capability** - Track state for cleanup
10. **Documentation as code** - Self-explanatory scripts

The ultimate goal: **When the pipeline passes, the code is ready for
production.**
