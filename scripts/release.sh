#!/bin/bash
#
# Release Script for svg-bbox
#
# BULLETPROOF RELEASE AUTOMATION
#
# This script provides fully automated, idempotent releases with:
# ✓ Auto-fix capabilities (lint, vitest config, package.json validation)
# ✓ Idempotency (safe to run multiple times, detects existing releases)
# ✓ Rollback on failure (restores clean state if anything goes wrong)
# ✓ Retry logic with exponential backoff (network failures)
# ✓ Better error visibility (shows errors instead of hiding them)
# ✓ Optional confirmation skip (--yes flag for CI/automation)
#
# RELEASE SEQUENCE (CRITICAL ORDER):
# 1. Validate environment and prerequisites
# 2. Auto-fix common issues (lint, vitest config, package.json)
# 3. Run all quality checks (lint, typecheck, tests)
# 4. Bump version in package.json and commit
# 5. Create git tag LOCALLY (don't push yet)
# 6. Push commits to GitHub (tag stays local) + wait for CI
# 7. Create GitHub Release → gh CLI pushes tag + creates release atomically
# 8. Tag push triggers GitHub Actions workflow
# 9. Wait for GitHub Actions to publish to npm (prepublishOnly hook runs in CI)
# 10. Verify npm publication
#
# Why this order matters:
# - Creating the GitHub Release BEFORE the workflow runs ensures release notes
#   are attached to the tag when the workflow executes
# - gh release create pushes the tag atomically with release creation
# - Avoids race condition where workflow starts before release exists
#
# Usage:
#   ./scripts/release.sh [--yes] [--verbose] [version]
#
# Examples:
#   ./scripts/release.sh 1.0.11            # Release specific version
#   ./scripts/release.sh patch             # Bump patch (1.0.10 → 1.0.11)
#   ./scripts/release.sh minor             # Bump minor (1.0.10 → 1.1.0)
#   ./scripts/release.sh major             # Bump major (1.0.10 → 2.0.0)
#   ./scripts/release.sh --yes patch       # Skip confirmation (for CI)
#   ./scripts/release.sh --verbose patch   # Enable verbose debug logging
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - npm installed
#   - pnpm installed
#   - jq installed
#   - git-cliff installed (for release notes generation)
#   - Clean working directory (no uncommitted changes)
#   - On main branch
#

set -e  # Exit on error
set -o pipefail  # Catch failures in pipes (e.g., cmd | grep will fail if cmd fails)

# Get package name from package.json
PACKAGE_NAME=$(grep '"name"' package.json | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')

# ══════════════════════════════════════════════════════════════════
# STATE TRACKING FOR ROLLBACK AND SIGNAL HANDLING
# These variables track what has been done so far, enabling proper cleanup
# ══════════════════════════════════════════════════════════════════
TAG_CREATED=false         # Local tag was created
TAG_PUSHED=false          # Tag was pushed to remote
RELEASE_CREATED=false     # GitHub Release was created
COMMITS_PUSHED=false      # Commits were pushed to remote
VERSION_BUMPED=false      # package.json was modified
CURRENT_TAG=""            # Store the tag name for cleanup
VERBOSE=false             # Verbose mode for debugging

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ══════════════════════════════════════════════════════════════════
# SIGNAL HANDLING AND CLEANUP
# Trap SIGINT (Ctrl+C), SIGTERM (kill), and EXIT to ensure cleanup
# ══════════════════════════════════════════════════════════════════

# Handle interrupts (Ctrl+C, kill) - clean up partial state
handle_interrupt() {
    local EXIT_CODE=$?
    echo "" >&2
    log_warning "Release interrupted by user or signal"

    # Perform cleanup based on what was done
    cleanup_on_interrupt

    exit 130  # Standard exit code for SIGINT
}

# Handle script exit (normal or error) - cleanup temp files
handle_exit() {
    local EXIT_CODE=$?

    # Only show cleanup message if not exiting cleanly
    if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 130 ]; then
        echo "" >&2
        log_warning "Script exited with code $EXIT_CODE"
    fi

    # Clean up temp files (always safe to do)
    rm -f /tmp/release-notes.md /tmp/lint-output.log /tmp/typecheck-output.log /tmp/test-output.log 2>/dev/null || true
}

# Cleanup function called on interrupt - removes partial state
cleanup_on_interrupt() {
    log_info "Cleaning up partial release state..."

    # Debug: Show current state
    log_verbose "State: TAG_CREATED=$TAG_CREATED, TAG_PUSHED=$TAG_PUSHED, RELEASE_CREATED=$RELEASE_CREATED"
    log_verbose "State: COMMITS_PUSHED=$COMMITS_PUSHED, VERSION_BUMPED=$VERSION_BUMPED"
    log_verbose "Current tag: $CURRENT_TAG"

    # If tag was created locally but not pushed, delete it
    # WHY: Prevents stale local tags that could cause confusion in future releases
    if [ "$TAG_CREATED" = true ] && [ "$TAG_PUSHED" = false ] && [ -n "$CURRENT_TAG" ]; then
        log_info "  → Deleting unpushed local tag: $CURRENT_TAG"
        log_verbose "Running: git tag -d $CURRENT_TAG"
        git tag -d "$CURRENT_TAG" 2>/dev/null || true
    fi

    # If version was bumped but not committed, restore package files
    # WHY: Prevents uncommitted version changes from polluting the working directory
    if [ "$VERSION_BUMPED" = true ] && [ "$COMMITS_PUSHED" = false ]; then
        if git diff --name-only | grep -qE "package.json|pnpm-lock.yaml"; then
            log_info "  → Restoring package.json and pnpm-lock.yaml"
            log_verbose "Running: git checkout package.json pnpm-lock.yaml"
            git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        fi
    fi

    # If commits were pushed but release failed, warn about orphaned state
    # WHY: User needs to know there are commits/tags on remote that may need cleanup
    if [ "$COMMITS_PUSHED" = true ] || [ "$TAG_PUSHED" = true ]; then
        log_warning "Commits or tags were pushed to remote before interruption"
        log_warning "You may need to manually clean up:"
        if [ "$TAG_PUSHED" = true ] && [ -n "$CURRENT_TAG" ]; then
            log_warning "  git push origin :refs/tags/$CURRENT_TAG  # Delete remote tag"
        fi
        if [ "$COMMITS_PUSHED" = true ]; then
            log_warning "  git reset --hard origin/main~1 && git push --force  # Revert commits (DANGEROUS)"
        fi
    fi

    log_success "Cleanup complete"
}

# Install signal handlers
# WHY: Ensures we always clean up, even if user presses Ctrl+C or script is killed
trap handle_interrupt SIGINT SIGTERM
trap handle_exit EXIT

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ ${NC}$1" >&2
}

log_success() {
    echo -e "${GREEN}✓${NC} $1" >&2
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1" >&2
}

log_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

# Verbose logging (only shown when --verbose flag is set)
# WHY: Helps debug script issues without cluttering normal output
log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}[VERBOSE]${NC} $1" >&2
    fi
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Strip ANSI color codes from string
# SECURITY: Prevents color codes from contaminating version strings used in git tags
strip_ansi() {
    # Remove all ANSI escape sequences: \x1b[...m or \033[...m
    echo "$1" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/\o033\[[0-9;]*m//g' | tr -d '\033' | tr -d '\000-\037'
}

# Validate semver version format (X.Y.Z only, no prefixes or suffixes)
# SECURITY: Prevents malformed version strings from breaking git tag creation
validate_version() {
    local VERSION=$1

    # Check if VERSION is empty or contains only whitespace
    if [ -z "$VERSION" ] || [ -z "${VERSION// /}" ]; then
        log_error "Version is empty or contains only whitespace"
        log_error "This indicates npm version command output was not captured correctly"
        return 1
    fi

    # Check for ANSI codes (shouldn't happen after strip_ansi, but double-check)
    if echo "$VERSION" | grep -q $'\033'; then
        log_error "Version contains ANSI color codes: '$VERSION'"
        log_error "This indicates color output contamination - check npm/log output"
        return 1
    fi

    # Validate semver format: must be exactly X.Y.Z where X,Y,Z are numbers
    if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        log_error "Invalid version format: '$VERSION'"
        log_error "Expected semver format (e.g., 1.0.12)"
        log_error "Got: $(echo "$VERSION" | od -c | head -5)"  # Show actual bytes for debugging
        return 1
    fi

    return 0
}

# Retry wrapper for network operations
retry_with_backoff() {
    local MAX_RETRIES=3
    local RETRY_COUNT=0
    local BACKOFF=2

    # WHY use $* instead of $@: When assigning to a string variable, $* concatenates
    # all arguments with the first character of IFS (space by default), while $@
    # would create an array which can't be assigned to a string variable.
    local CMD="$*"

    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if eval "$CMD"; then
            return 0
        fi

        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
            log_warning "Command failed, retrying in ${BACKOFF}s... (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)"
            sleep $BACKOFF
            BACKOFF=$((BACKOFF * 2))
        fi
    done

    log_error "Command failed after $MAX_RETRIES attempts: $CMD"
    return 1
}

# Validate prerequisites
validate_prerequisites() {
    log_info "Validating prerequisites..."

    # Check for required commands
    if ! command_exists gh; then
        log_error "gh CLI is not installed. Install from: https://cli.github.com/"
        exit 1
    fi

    if ! command_exists npm; then
        log_error "npm is not installed"
        exit 1
    fi

    if ! command_exists pnpm; then
        log_error "pnpm is not installed"
        exit 1
    fi

    if ! command_exists jq; then
        log_error "jq is not installed. Install with: brew install jq (macOS) or apt-get install jq (Linux)"
        exit 1
    fi

    if ! command_exists git-cliff; then
        log_error "git-cliff is not installed. Install from: https://github.com/orhun/git-cliff"
        log_info "  macOS: brew install git-cliff"
        log_info "  Linux: cargo install git-cliff"
        exit 1
    fi

    # Check gh auth status
    if ! gh auth status >/dev/null 2>&1; then
        log_error "GitHub CLI is not authenticated. Run: gh auth login"
        exit 1
    fi

    log_success "All prerequisites met"
}

# Check if working directory is clean
check_clean_working_dir() {
    log_info "Checking working directory..."

    if ! git diff-index --quiet HEAD --; then
        log_error "Working directory is not clean. Commit or stash changes first."
        git status --short
        exit 1
    fi

    log_success "Working directory is clean"
}

# Check if on main branch
check_main_branch() {
    log_info "Checking current branch..."

    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT_BRANCH" != "main" ]; then
        log_error "Must be on main branch (currently on $CURRENT_BRANCH)"
        exit 1
    fi

    log_success "On main branch"
}

# CRITICAL: Check that local main is synced with remote
# WHY: If local is behind origin/main, push will fail or create conflicts
# If local is ahead, there are unpushed commits that might interfere
check_branch_synced() {
    log_info "Checking branch synchronization with remote..."

    # Fetch latest from remote (required to compare)
    # WHY: Without fetch, local refs might be stale
    if ! git fetch origin main --quiet 2>/dev/null; then
        log_error "Failed to fetch from origin"
        log_error "Check network connection and repository access"
        exit 1
    fi

    local LOCAL_SHA REMOTE_SHA
    LOCAL_SHA=$(git rev-parse HEAD)
    REMOTE_SHA=$(git rev-parse origin/main)

    if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
        # Check if we're ahead or behind
        local AHEAD BEHIND
        AHEAD=$(git rev-list --count origin/main..HEAD)
        BEHIND=$(git rev-list --count HEAD..origin/main)

        if [ "$BEHIND" -gt 0 ]; then
            log_error "Local branch is $BEHIND commit(s) BEHIND origin/main"
            log_error "Run: git pull origin main"
            exit 1
        fi

        if [ "$AHEAD" -gt 0 ]; then
            log_error "Local branch is $AHEAD commit(s) AHEAD of origin/main"
            log_error "These unpushed commits will be included in the release"
            log_error "Push them first: git push origin main"
            log_error "Or reset to origin: git reset --hard origin/main"
            exit 1
        fi
    fi

    log_success "Local branch is in sync with origin/main"
}

# Check that required GitHub workflow files exist
# WHY: Release depends on ci.yml and publish.yml workflows
# If they're missing or broken, release will fail at CI stage
check_workflow_files_exist() {
    log_info "Checking GitHub workflow files..."

    local REQUIRED_WORKFLOWS=(
        ".github/workflows/ci.yml"
        ".github/workflows/publish.yml"
    )

    local MISSING=""
    for WORKFLOW in "${REQUIRED_WORKFLOWS[@]}"; do
        if [ ! -f "$WORKFLOW" ]; then
            MISSING="${MISSING}${WORKFLOW} "
        fi
    done

    if [ -n "$MISSING" ]; then
        log_error "Missing required workflow files: $MISSING"
        log_error "Release cannot proceed without CI/CD workflows"
        exit 1
    fi

    # Basic YAML syntax check (catch obvious errors)
    # WHY: Broken workflow YAML will cause CI to fail silently
    for WORKFLOW in "${REQUIRED_WORKFLOWS[@]}"; do
        # Use node to validate YAML since it's always available
        if ! node -e "require('fs').readFileSync('$WORKFLOW', 'utf8')" 2>/dev/null; then
            log_error "Cannot read workflow file: $WORKFLOW"
            exit 1
        fi
    done

    log_success "GitHub workflow files present"
}

# Check network connectivity to GitHub and npm
# WHY: Release requires both services; fail fast if unreachable
check_network_connectivity() {
    log_info "Checking network connectivity..."

    # Check GitHub API
    if ! gh api user --silent 2>/dev/null; then
        log_error "Cannot reach GitHub API"
        log_error "Check network connection and gh auth status"
        exit 1
    fi

    # Check npm registry
    if ! npm ping --registry https://registry.npmjs.org 2>/dev/null; then
        log_warning "npm registry ping failed (may be normal)"
        # Not fatal - npm ping can fail even when registry is accessible
    fi

    log_success "Network connectivity OK"
}

# Check Node.js version matches CI requirements
# WHY: Different Node versions can cause test discrepancies
check_node_version() {
    log_info "Checking Node.js version..."

    local NODE_VERSION
    NODE_VERSION=$(node --version | sed 's/v//')
    local NODE_MAJOR
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

    # CI uses Node 24 for npm trusted publishing (requires npm 11.5.1+)
    # Local can use 18+ but should warn if different from CI
    if [ "$NODE_MAJOR" -lt 18 ]; then
        log_error "Node.js version $NODE_VERSION is too old"
        log_error "Minimum required: Node.js 18"
        exit 1
    fi

    if [ "$NODE_MAJOR" -lt 24 ]; then
        log_warning "Local Node.js $NODE_VERSION differs from CI (Node 24)"
        log_warning "Tests may behave differently"
    else
        log_success "Node.js version OK: $NODE_VERSION"
    fi
}

# PHASE 1.5: Validate version synchronization across files
# Check that package.json version matches version.cjs and minified preamble
# Auto-rebuilds minified file if version mismatch is detected
validate_version_sync() {
    log_info "Validating version synchronization..."

    # Get version from package.json
    local PKG_VERSION
    PKG_VERSION=$(get_current_version)

    # Get version from version.cjs
    local VERSION_CJS_VERSION
    if [ -f "version.cjs" ]; then
        # Extract version from: const VERSION = '1.0.12';
        VERSION_CJS_VERSION=$(grep "const VERSION" version.cjs | sed "s/.*'\([^']*\)'.*/\1/" | head -1)
        if [ -z "$VERSION_CJS_VERSION" ]; then
            log_warning "Could not extract version from version.cjs"
        elif [ "$PKG_VERSION" != "$VERSION_CJS_VERSION" ]; then
            log_error "Version mismatch: package.json=$PKG_VERSION, version.cjs=$VERSION_CJS_VERSION"
            log_error "Run 'npm run build' to sync versions, then commit"
            return 1
        fi
    else
        log_warning "version.cjs not found - skipping version.cjs check"
    fi

    # Get version from SvgVisualBBox.min.js preamble comment
    local MINIFIED_VERSION
    if [ -f "SvgVisualBBox.min.js" ]; then
        # Extract version from preamble: /*! SvgVisualBBox v1.0.12 - ...
        MINIFIED_VERSION=$(head -1 SvgVisualBBox.min.js | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | sed 's/v//')
        if [ -z "$MINIFIED_VERSION" ]; then
            log_warning "Could not extract version from SvgVisualBBox.min.js preamble"
        elif [ "$PKG_VERSION" != "$MINIFIED_VERSION" ]; then
            # SAFEGUARD: Auto-rebuild minified file if version mismatch
            # WHY: Version mismatch between package.json and minified header
            # was a recurring issue causing release failures
            log_warning "Version mismatch: package.json=$PKG_VERSION, SvgVisualBBox.min.js=$MINIFIED_VERSION"
            log_info "  → Auto-rebuilding minified library..."

            # IMPROVEMENT: Capture build output for debugging
            # WHY: If build fails, user needs to see error messages
            # DO NOT: Silently discard build errors - they're critical for debugging
            local BUILD_OUTPUT
            local BUILD_EXIT_CODE
            BUILD_OUTPUT=$(pnpm run build 2>&1)
            BUILD_EXIT_CODE=$?

            # Show build output in verbose mode (helps debug build issues)
            if [ "$VERBOSE" = true ]; then
                log_verbose "Build output:"
                echo "$BUILD_OUTPUT" | while IFS= read -r line; do
                    log_verbose "  $line"
                done
            fi

            if [ $BUILD_EXIT_CODE -eq 0 ]; then
                # Brief delay to ensure filesystem has synced the file
                # WHY: On some systems, file may not be immediately readable after write
                sleep 0.5

                # Re-check version after rebuild
                MINIFIED_VERSION=$(head -1 SvgVisualBBox.min.js | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | sed 's/v//')
                if [ "$PKG_VERSION" = "$MINIFIED_VERSION" ]; then
                    log_success "  Minified library rebuilt successfully (v$PKG_VERSION)"
                    # Commit the rebuilt file if it changed
                    if ! git diff --quiet SvgVisualBBox.min.js 2>/dev/null; then
                        log_info "  → Committing rebuilt minified library..."
                        git add SvgVisualBBox.min.js

                        # IMPROVEMENT: Handle git commit failure properly
                        # WHY: `|| true` silently swallows errors which can cause confusion
                        # DO NOT: Use `|| true` for operations that should always succeed
                        if ! git commit -m "build: Regenerate minified library for v$PKG_VERSION"; then
                            log_error "  Failed to commit rebuilt minified library"
                            log_error "  Check git status and resolve any issues"
                            return 1
                        fi
                        log_success "  Minified library committed"
                    fi
                else
                    log_error "Build completed but version still mismatched"
                    log_error "Expected: $PKG_VERSION, Got: $MINIFIED_VERSION"
                    log_error "This may indicate a bug in the build script"
                    return 1
                fi
            else
                # IMPROVEMENT: Show actual build errors
                # WHY: User needs to know WHY the build failed
                log_error "Failed to rebuild minified library (exit code: $BUILD_EXIT_CODE)"
                log_error "Build output:"
                echo "$BUILD_OUTPUT" | tail -20 | while IFS= read -r line; do
                    log_error "  $line"
                done
                log_error "Run 'pnpm run build' manually to see full errors"
                return 1
            fi
        fi
    else
        log_warning "SvgVisualBBox.min.js not found - skipping minified preamble check"
    fi

    log_success "Version synchronization validated: $PKG_VERSION"
    return 0
}

# PHASE 1.6: Validate UMD wrapper syntax before release
# Ensures the minified file can be parsed by Node.js without syntax errors
# and properly exports the SvgVisualBBox namespace
validate_umd_wrapper() {
    log_info "Validating UMD wrapper syntax..."

    local MINIFIED_FILE="SvgVisualBBox.min.js"

    # Check if minified file exists
    if [ ! -f "$MINIFIED_FILE" ]; then
        log_error "Minified file not found: $MINIFIED_FILE"
        log_error "Run 'npm run build' to generate minified file"
        return 1
    fi

    # Step 1: Use node --check to validate JavaScript syntax
    # This parses the file without executing it - fast and safe
    if ! node --check "$MINIFIED_FILE" 2>/dev/null; then
        log_error "Syntax error in $MINIFIED_FILE"
        log_error "The minification may have introduced invalid JavaScript"
        log_error "Run 'npm run build' and check for errors"
        return 1
    fi

    log_success "Minified file has valid JavaScript syntax"

    # Step 2: Verify UMD wrapper structure contains expected exports
    # The minified file is browser-targeted, so we verify structure via grep
    # rather than trying to execute browser-dependent code in Node.js
    local EXPECTED_EXPORTS=(
        "getSvgElementVisualBBoxTwoPassAggressive"
        "getSvgElementsUnionVisualBBox"
        "waitForDocumentFonts"
    )

    for export_name in "${EXPECTED_EXPORTS[@]}"; do
        if ! grep -q "$export_name" "$MINIFIED_FILE"; then
            log_error "UMD wrapper missing expected export: $export_name"
            log_error "The minification may have removed or corrupted this function"
            return 1
        fi
    done

    # Step 3: Verify UMD factory pattern structure
    # Check for the characteristic UMD wrapper pattern
    if ! grep -q 'module.exports' "$MINIFIED_FILE"; then
        log_error "UMD wrapper missing CommonJS export (module.exports)"
        return 1
    fi

    if ! grep -q 'SvgVisualBBox' "$MINIFIED_FILE"; then
        log_error "UMD wrapper missing SvgVisualBBox namespace"
        return 1
    fi

    log_success "UMD wrapper structure verified (exports and namespace present)"

    return 0
}

# PHASE 1.8: Check if git tag already exists (locally or remotely)
# Prevents duplicate releases and detects stale local tags
check_tag_not_exists() {
    local VERSION=$1

    # Check local tags
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_error "Git tag v$VERSION already exists locally"
        log_info "To delete: git tag -d v$VERSION"
        return 1
    fi

    # Check remote tags
    if git ls-remote --tags origin 2>/dev/null | grep -q "refs/tags/v$VERSION"; then
        log_error "Git tag v$VERSION already exists on remote"
        log_info "To delete: git push origin :refs/tags/v$VERSION"
        return 1
    fi

    return 0
}

# PHASE 1.8: Display pre-flight checklist header
show_preflight_header() {
    echo "" >&2
    echo "┌──────────────────────────────────────────────────────────────┐" >&2
    echo "│                    PRE-FLIGHT CHECKLIST                      │" >&2
    echo "└──────────────────────────────────────────────────────────────┘" >&2
    echo "" >&2
}

# PHASE 1.8: Display pre-flight checklist summary
show_preflight_summary() {
    local PASSED=$1
    local TOTAL=$2

    echo "" >&2
    if [ "$PASSED" -eq "$TOTAL" ]; then
        log_success "Pre-flight checklist passed ($PASSED/$TOTAL checks)"
    else
        log_error "Pre-flight checklist failed ($PASSED/$TOTAL checks)"
    fi
    echo "" >&2
}

# Get current version from package.json
get_current_version() {
    grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/'
}

# Bump version using npm version
bump_version() {
    local VERSION_TYPE=$1

    log_info "Bumping version ($VERSION_TYPE)..."

    # SECURITY: Silence npm entirely to prevent hook output contamination
    # npm lifecycle hooks ("version", "prepublishOnly") output to stdout, which
    # cannot be suppressed with 2>/dev/null. We must silence all npm output
    # and read the version from package.json instead.
    npm version "$VERSION_TYPE" --no-git-tag-version >/dev/null 2>&1

    # Check if npm version succeeded
    # WHY: npm can fail silently, we must verify it actually worked
    if [ $? -ne 0 ]; then
        log_error "npm version command failed"
        log_error "Run manually to see errors: npm version $VERSION_TYPE --no-git-tag-version"
        exit 1
    fi

    # Read the new version from package.json (the source of truth)
    NEW_VERSION=$(get_current_version)

    # VERIFICATION: Ensure package.json was actually modified
    # WHY: Catches silent npm failures where command succeeds but files aren't updated
    if [ -z "$NEW_VERSION" ]; then
        log_error "npm version succeeded but package.json version is empty"
        log_error "This indicates a silent npm failure"
        exit 1
    fi

    # SECURITY: Strip any ANSI codes that might have leaked through
    NEW_VERSION=$(strip_ansi "$NEW_VERSION")

    # SECURITY: Validate version format before proceeding
    if ! validate_version "$NEW_VERSION"; then
        log_error "Version bump failed - invalid version format"
        log_error "Check package.json for errors"
        exit 1
    fi

    # VERIFICATION: Ensure pnpm-lock.yaml was also updated
    # WHY: npm version should update both files; if it didn't, lock file is stale
    if [ -f "pnpm-lock.yaml" ]; then
        if ! grep -q "version: $NEW_VERSION" pnpm-lock.yaml; then
            log_warning "pnpm-lock.yaml may not be updated to match package.json"
            log_warning "Run 'pnpm install' to sync lock file"
        fi
    fi

    # Mark version as bumped (for cleanup tracking)
    VERSION_BUMPED=true

    log_success "Version bumped to $NEW_VERSION"
    echo "$NEW_VERSION"
}

# Set specific version
set_version() {
    local VERSION=$1

    # SECURITY: Validate input version BEFORE calling npm
    VERSION=$(strip_ansi "$VERSION")
    if ! validate_version "$VERSION"; then
        log_error "Invalid version specified: $VERSION"
        exit 1
    fi

    log_info "Setting version to $VERSION..."

    # SECURITY: Silence npm entirely to prevent hook output contamination
    npm version "$VERSION" --no-git-tag-version >/dev/null 2>&1

    # Check if npm version succeeded
    # WHY: npm can fail silently, we must verify it actually worked
    if [ $? -ne 0 ]; then
        log_error "npm version command failed"
        log_error "Run manually to see errors: npm version $VERSION --no-git-tag-version"
        exit 1
    fi

    # SECURITY: Re-validate after npm (paranoid check)
    # Read from package.json (the source of truth) instead of capturing npm output
    ACTUAL_VERSION=$(get_current_version)

    # VERIFICATION: Ensure version was actually set
    # WHY: Catches silent npm failures where command succeeds but files aren't updated
    if [ -z "$ACTUAL_VERSION" ]; then
        log_error "npm version succeeded but package.json version is empty"
        log_error "This indicates a silent npm failure"
        exit 1
    fi

    if [ "$ACTUAL_VERSION" != "$VERSION" ]; then
        log_error "Version mismatch after npm: expected $VERSION, got $ACTUAL_VERSION"
        exit 1
    fi

    # VERIFICATION: Ensure pnpm-lock.yaml was also updated
    # WHY: npm version should update both files; if it didn't, lock file is stale
    if [ -f "pnpm-lock.yaml" ]; then
        if ! grep -q "version: $VERSION" pnpm-lock.yaml; then
            log_warning "pnpm-lock.yaml may not be updated to match package.json"
            log_warning "Run 'pnpm install' to sync lock file"
        fi
    fi

    # Mark version as bumped (for cleanup tracking)
    VERSION_BUMPED=true

    log_success "Version set to $VERSION"
    echo "$VERSION"
}

# Auto-fix common issues before quality checks
auto_fix_issues() {
    log_info "Auto-fixing common issues..."

    # Fix 1: Auto-fix linting issues
    log_info "  → Auto-fixing lint issues..."
    if pnpm run lint:fix >/dev/null 2>&1; then
        log_success "  Lint auto-fix completed"
    else
        log_warning "  Lint auto-fix had issues (will verify in quality checks)"
    fi

    # Fix 2: Verify vitest config uses threads (not forks to avoid worker crash)
    log_info "  → Checking vitest config..."
    if grep -q "pool: 'forks'" vitest.config.js 2>/dev/null; then
        log_warning "  Detected 'forks' pool in vitest.config.js (known to cause crashes)"
        log_info "  → Auto-fixing: switching to 'threads' pool..."
        sed -i.bak "s/pool: 'forks'/pool: 'threads'/" vitest.config.js
        rm -f vitest.config.js.bak
        log_success "  Vitest config fixed (forks → threads)"
    else
        log_success "  Vitest config OK (using threads pool)"
    fi

    # Fix 3: Verify package.json includes required directories
    log_info "  → Verifying package.json 'files' array..."
    MISSING_DIRS=""
    if ! grep -q '"config/"' package.json; then
        MISSING_DIRS="${MISSING_DIRS}config/ "
    fi
    if ! grep -q '"lib/"' package.json; then
        MISSING_DIRS="${MISSING_DIRS}lib/ "
    fi

    if [ -n "$MISSING_DIRS" ]; then
        log_error "Missing directories in package.json 'files' array: $MISSING_DIRS"
        log_error "This will cause MODULE_NOT_FOUND errors after npm install"
        exit 1
    fi
    log_success "  package.json 'files' array complete"

    # Commit auto-fixes if there are any changes
    if ! git diff-index --quiet HEAD --; then
        log_info "  → Committing auto-fixes..."
        git add -A
        git commit -m "chore: Auto-fix issues before release (lint, vitest config)" || true
        log_success "  Auto-fixes committed"
    else
        log_success "  No auto-fixes needed"
    fi

    log_success "Auto-fix complete"
}

# ══════════════════════════════════════════════════════════════════
# COMPREHENSIVE QUALITY CHECKS
# These checks mirror EXACTLY what CI does to prevent surprises
# WHY: Any difference between local checks and CI causes release failures
# ══════════════════════════════════════════════════════════════════

# Validate JSON files are syntactically correct
# WHY: Invalid JSON breaks npm, eslint, and other tools silently
validate_json_files() {
    log_info "  → Validating JSON files..."

    local JSON_FILES=(
        "package.json"
        "tsconfig.json"
    )

    local INVALID=""
    for JSON_FILE in "${JSON_FILES[@]}"; do
        if [ -f "$JSON_FILE" ]; then
            if ! node -e "JSON.parse(require('fs').readFileSync('$JSON_FILE', 'utf8'))" 2>/dev/null; then
                INVALID="${INVALID}${JSON_FILE} "
            fi
        fi
    done

    if [ -n "$INVALID" ]; then
        log_error "Invalid JSON syntax in: $INVALID"
        return 1
    fi

    log_success "  JSON files valid"
    return 0
}

# Validate YAML workflow files
# WHY: Invalid YAML causes CI to fail silently or behave unexpectedly
validate_yaml_files() {
    log_info "  → Validating YAML workflow files..."

    local YAML_FILES=(
        ".github/workflows/ci.yml"
        ".github/workflows/publish.yml"
    )

    local INVALID=""
    for YAML_FILE in "${YAML_FILES[@]}"; do
        if [ -f "$YAML_FILE" ]; then
            # Use node to parse YAML (js-yaml is often available, or use basic check)
            # Basic check: ensure file is readable and has valid structure
            if ! head -1 "$YAML_FILE" | grep -qE '^name:|^on:|^#' 2>/dev/null; then
                # Try node-based validation
                if ! node -e "
                    const fs = require('fs');
                    const content = fs.readFileSync('$YAML_FILE', 'utf8');
                    // Basic YAML validation - check for common syntax errors
                    if (content.includes('\t')) {
                        console.error('YAML contains tabs');
                        process.exit(1);
                    }
                " 2>/dev/null; then
                    INVALID="${INVALID}${YAML_FILE} "
                fi
            fi
        fi
    done

    if [ -n "$INVALID" ]; then
        log_error "Potentially invalid YAML in: $INVALID"
        return 1
    fi

    log_success "  YAML workflow files valid"
    return 0
}

# Validate package.json has all required fields and files
# WHY: Missing files in "files" array causes MODULE_NOT_FOUND after npm install
validate_package_json_completeness() {
    log_info "  → Validating package.json completeness..."

    # Check required fields exist
    local REQUIRED_FIELDS=("name" "version" "main" "bin" "files")
    for FIELD in "${REQUIRED_FIELDS[@]}"; do
        if ! grep -q "\"$FIELD\"" package.json; then
            log_error "package.json missing required field: $FIELD"
            return 1
        fi
    done

    # Check that files in "bin" actually exist
    local BIN_FILES
    BIN_FILES=$(node -e "
        const pkg = require('./package.json');
        if (pkg.bin) {
            Object.values(pkg.bin).forEach(f => console.log(f));
        }
    " 2>/dev/null)

    local MISSING_BIN=""
    while IFS= read -r BIN_FILE; do
        if [ -n "$BIN_FILE" ] && [ ! -f "$BIN_FILE" ]; then
            MISSING_BIN="${MISSING_BIN}${BIN_FILE} "
        fi
    done <<< "$BIN_FILES"

    if [ -n "$MISSING_BIN" ]; then
        log_error "package.json bin files missing: $MISSING_BIN"
        return 1
    fi

    # Check that main entry point exists
    local MAIN_FILE
    MAIN_FILE=$(node -e "console.log(require('./package.json').main || '')" 2>/dev/null)
    if [ -n "$MAIN_FILE" ] && [ ! -f "$MAIN_FILE" ]; then
        log_error "package.json main file missing: $MAIN_FILE"
        return 1
    fi

    log_success "  package.json complete"
    return 0
}

# Run quality checks - COMPREHENSIVE version matching CI exactly
run_quality_checks() {
    log_info "Running comprehensive quality checks (matching CI exactly)..."
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 1: CONFIGURATION VALIDATION
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 1: Configuration Validation"

    validate_json_files || exit 1
    validate_yaml_files || exit 1
    validate_package_json_completeness || exit 1

    log_success "└─ Configuration validation passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 2: FORMATTING CHECK (Prettier)
    # WHY: CI runs prettier --check, so we must too
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 2: Formatting Check"

    log_info "  → Checking code formatting (prettier)..."
    if ! pnpm exec prettier --check . 2>&1 | tee /tmp/prettier-output.log | tail -10; then
        log_error "Formatting check failed - files need formatting"
        log_error "Run: pnpm run format"
        log_error "Full output: /tmp/prettier-output.log"
        exit 1
    fi
    log_success "  Formatting check passed"

    log_success "└─ Formatting check passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 3: LINTING (ESLint)
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 3: Linting"

    log_info "  → Running ESLint..."
    if ! pnpm exec eslint . 2>&1 | tee /tmp/eslint-output.log | tail -20; then
        log_error "ESLint failed"
        log_error "Full output: /tmp/eslint-output.log"
        exit 1
    fi
    log_success "  ESLint passed"

    log_success "└─ Linting passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 4: TYPE CHECKING (TypeScript)
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 4: Type Checking"

    log_info "  → Running TypeScript type checker..."
    if ! pnpm run typecheck 2>&1 | tee /tmp/typecheck-output.log | tail -20; then
        log_error "Type checking failed"
        log_error "Full output: /tmp/typecheck-output.log"
        exit 1
    fi
    log_success "  Type checking passed"

    log_success "└─ Type checking passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 5: UNIT & INTEGRATION TESTS (ALL tests, not selective)
    # WHY: CI runs ALL tests, so we must too to catch failures
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 5: Running ALL Tests (Unit + Integration)"

    log_info "  → Running full test suite (this may take several minutes)..."
    log_info "  → (CI runs ALL tests, not selective - we must match CI exactly)"
    if ! pnpm test 2>&1 | tee /tmp/test-output.log | tail -60; then
        log_error "Tests failed"
        log_error "Full output: /tmp/test-output.log"
        # Show failed tests summary
        log_error "Failed tests:"
        grep -E "FAIL|✗|AssertionError" /tmp/test-output.log | head -20 || true
        exit 1
    fi
    log_success "  All unit & integration tests passed"

    log_success "└─ Tests passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 6: E2E TESTS (Playwright)
    # WHY: CI runs E2E tests separately, failures here block release
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 6: E2E Tests (Playwright)"

    log_info "  → Running E2E tests..."
    if ! pnpm run test:e2e 2>&1 | tee /tmp/e2e-output.log | tail -30; then
        log_error "E2E tests failed"
        log_error "Full output: /tmp/e2e-output.log"
        exit 1
    fi
    log_success "  E2E tests passed"

    log_success "└─ E2E tests passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 7: BUILD VERIFICATION
    # WHY: Ensure minified file builds correctly before release
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 7: Build Verification"

    log_info "  → Building minified library..."
    if ! pnpm run build 2>&1 | tee /tmp/build-output.log | tail -10; then
        log_error "Build failed"
        log_error "Full output: /tmp/build-output.log"
        exit 1
    fi
    log_success "  Build succeeded"

    # Verify build output exists and is valid
    if [ ! -f "SvgVisualBBox.min.js" ]; then
        log_error "Build did not produce SvgVisualBBox.min.js"
        exit 1
    fi

    # Verify build has no syntax errors
    if ! node --check SvgVisualBBox.min.js 2>/dev/null; then
        log_error "Built file has JavaScript syntax errors"
        exit 1
    fi
    log_success "  Build output verified"

    log_success "└─ Build verification passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # ALL CHECKS PASSED
    # ════════════════════════════════════════════════════════════════
    log_success "═══════════════════════════════════════════════════════════"
    log_success "All quality checks passed - ready for release"
    log_success "═══════════════════════════════════════════════════════════"
    echo ""
}

# Generate release notes using git-cliff
generate_release_notes() {
    local VERSION=$1
    local PREVIOUS_TAG=$2

    log_info "Generating release notes using git-cliff..."

    # Check if git-cliff is installed
    if ! command_exists git-cliff; then
        log_error "git-cliff is not installed. Install from: https://github.com/orhun/git-cliff"
        log_info "macOS: brew install git-cliff"
        log_info "Linux: cargo install git-cliff"
        exit 1
    fi

    # Generate changelog for the version range using git-cliff
    if [ -z "$PREVIOUS_TAG" ]; then
        # First release - include all commits
        CHANGELOG_SECTION=$(git-cliff --unreleased --strip header)
    else
        # Generate changelog from previous tag to HEAD
        CHANGELOG_SECTION=$(git-cliff --unreleased --strip header "${PREVIOUS_TAG}..")
    fi

    if [ -z "$CHANGELOG_SECTION" ]; then
        log_warning "No changes found by git-cliff"
        CHANGELOG_SECTION="No notable changes in this release."
    fi

    # Strip the "## [unreleased]" header since we use "What's Changed"
    CHANGELOG_SECTION=$(echo "$CHANGELOG_SECTION" | sed '/^## \[unreleased\]/d')

    # Build release notes with git-cliff output and enhanced formatting
    cat > /tmp/release-notes.md <<EOF
## What's Changed

${CHANGELOG_SECTION}

---

## ◆ Installation

### npm / pnpm / yarn

\`\`\`bash
npm install ${PACKAGE_NAME}@${VERSION}
pnpm add ${PACKAGE_NAME}@${VERSION}
yarn add ${PACKAGE_NAME}@${VERSION}
\`\`\`

### Browser (CDN)

#### jsDelivr (Recommended)
\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${VERSION}/SvgVisualBBox.min.js"></script>
\`\`\`

#### unpkg
\`\`\`html
<script src="https://unpkg.com/${PACKAGE_NAME}@${VERSION}/SvgVisualBBox.min.js"></script>
\`\`\`

---

**Full Changelog**: https://github.com/\$(gh repo view --json nameWithOwner -q .nameWithOwner)/compare/${PREVIOUS_TAG}...v${VERSION}
EOF

    log_success "Release notes generated using git-cliff"
    log_info "Preview: /tmp/release-notes.md"
}

# Commit version bump
commit_version_bump() {
    local VERSION=$1

    log_info "Committing version bump..."

    git add package.json pnpm-lock.yaml
    git commit -m "chore(release): Bump version to $VERSION"

    log_success "Version bump committed"
}

# Create git tag
create_git_tag() {
    local VERSION=$1

    # SECURITY: Strip ANSI codes and validate version format
    # This prevents contaminated version strings from breaking git tag creation
    VERSION=$(strip_ansi "$VERSION")
    if ! validate_version "$VERSION"; then
        log_error "Cannot create git tag - invalid version format: '$VERSION'"
        log_error "This should never happen if bump_version/set_version worked correctly"
        return 1
    fi

    log_info "Creating git tag v$VERSION..."

    # Store tag name for cleanup (before creating, in case we fail)
    CURRENT_TAG="v$VERSION"

    # Delete tag if it exists locally
    # WHY: Prevents "tag already exists" errors if script is re-run
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_warning "Tag v$VERSION already exists locally, deleting..."
        git tag -d "v$VERSION"
    fi

    # Create annotated tag
    # SECURITY: Quote the tag name to prevent shell injection (paranoid)
    if ! git tag -a "v${VERSION}" -m "Release v${VERSION}"; then
        log_error "Failed to create git tag v$VERSION"
        return 1
    fi

    # Mark tag as created (for cleanup tracking)
    TAG_CREATED=true

    log_success "Git tag created"
}

# Push commits only (tag will be pushed by gh release create)
push_commits_to_github() {
    log_info "Pushing commits to GitHub..."

    # PHASE 1.1: Capture the HEAD commit SHA BEFORE pushing for workflow filtering
    local HEAD_SHA
    HEAD_SHA=$(git rev-parse HEAD)
    log_info "Pushing commit: ${HEAD_SHA:0:7}"

    # Use retry logic for git push (network operation)
    if ! retry_with_backoff "git push origin main"; then
        log_error "Failed to push commits after retries"

        # ROLLBACK: Delete local tag since we couldn't push commits
        # WHY: If commits can't be pushed, the tag is useless and will cause confusion
        if [ "$TAG_CREATED" = true ] && [ -n "$CURRENT_TAG" ]; then
            log_warning "Deleting local tag $CURRENT_TAG (commits couldn't be pushed)"
            git tag -d "$CURRENT_TAG" 2>/dev/null || true
            TAG_CREATED=false
        fi

        return 1
    fi

    # Mark commits as pushed (for cleanup tracking)
    COMMITS_PUSHED=true

    log_success "Commits pushed"

    log_info "Waiting for CI workflow to complete (this may take 3-10 minutes)..."
    # PHASE 1.1: Pass commit SHA to wait_for_ci_workflow for filtering
    wait_for_ci_workflow "$HEAD_SHA"
}

# Create GitHub Release (this pushes the tag and triggers the workflow)
create_github_release() {
    local VERSION=$1

    # SECURITY: Strip ANSI codes and validate version format
    VERSION=$(strip_ansi "$VERSION")
    if ! validate_version "$VERSION"; then
        log_error "Cannot create GitHub release - invalid version format: '$VERSION'"
        return 1
    fi

    log_info "Creating GitHub Release (this will push the tag and trigger workflow)..."

    # Check if release already exists (idempotency)
    if gh release view "v$VERSION" >/dev/null 2>&1; then
        log_warning "GitHub Release v$VERSION already exists"
        log_info "Skipping release creation (idempotent)"
        RELEASE_CREATED=true
        TAG_PUSHED=true
        return 0
    fi

    # Check if tag exists remotely
    if git ls-remote --tags origin | grep -q "refs/tags/v$VERSION"; then
        log_warning "Tag v$VERSION already exists on remote"
        TAG_PUSHED=true
        log_info "Creating release for existing tag..."

        # Try to create release for existing tag
        if ! gh release create "v$VERSION" \
            --title "v$VERSION" \
            --notes-file /tmp/release-notes.md; then
            log_error "Failed to create GitHub Release for existing tag"
            log_warning "Tag v$VERSION exists on remote but release creation failed"
            log_warning "Manual cleanup may be needed: gh release create v$VERSION"
            return 1
        fi

        RELEASE_CREATED=true
        log_success "GitHub Release created for existing tag"
        return 0
    fi

    # Create release using gh CLI
    # The tag already exists locally, gh will push it when creating the release
    if ! gh release create "v$VERSION" \
        --title "v$VERSION" \
        --notes-file /tmp/release-notes.md; then
        log_error "Failed to create GitHub Release"

        # ROLLBACK WARNING: Tag may have been pushed even though release creation failed
        # WHY: gh release create pushes the tag first, then creates the release
        # If release creation fails after tag push, we have an orphaned tag
        if git ls-remote --tags origin | grep -q "refs/tags/v$VERSION"; then
            TAG_PUSHED=true
            log_warning "Tag v$VERSION was pushed to remote, but release creation failed"
            log_warning "You have an orphaned tag on remote. To clean up:"
            log_warning "  git push origin :refs/tags/v$VERSION"
        fi

        return 1
    fi

    # Mark tag as pushed and release as created (gh release create does both atomically)
    TAG_PUSHED=true
    RELEASE_CREATED=true

    log_success "GitHub Release created: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$VERSION"
    log_success "Tag pushed and workflow triggered"
}

# Wait for CI workflow after pushing commits
# PHASE 1.1: Filter by commit SHA to avoid race conditions with other commits
wait_for_ci_workflow() {
    local COMMIT_SHA=$1  # The commit SHA we just pushed
    local MAX_WAIT=600   # 10 minutes
    local ELAPSED=0

    sleep 5  # Give GitHub a moment to register the push

    log_info "Monitoring CI workflow for commit ${COMMIT_SHA:0:7}..."
    log_info "  (lint, typecheck, test, e2e, coverage)"

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # PHASE 1.1: Filter workflows by HEAD commit SHA to avoid race conditions
        # This ensures we only track the workflow for OUR specific commit
        WORKFLOW_JSON=$(gh run list --workflow=ci.yml --branch=main --limit 5 --json status,conclusion,headSha,databaseId 2>/dev/null || echo "[]")

        # Find the workflow run matching our commit SHA
        # WHY use first(): jq '.[] | select()' can return multiple objects on separate lines
        # which breaks subsequent jq parsing. 'first()' returns only the first match as valid JSON.
        # FIX for "jq: parse error: Unfinished JSON term at EOF" bug
        MATCHING_RUN=$(echo "$WORKFLOW_JSON" | jq -r --arg sha "$COMMIT_SHA" 'first(.[] | select(.headSha == $sha))' 2>/dev/null)

        if [ -z "$MATCHING_RUN" ] || [ "$MATCHING_RUN" = "null" ]; then
            echo -n "."
            sleep 5
            ELAPSED=$((ELAPSED + 5))
            continue
        fi

        WORKFLOW_STATUS=$(echo "$MATCHING_RUN" | jq -r '.status' 2>/dev/null)

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            echo ""  # Newline after progress dots
            WORKFLOW_CONCLUSION=$(echo "$MATCHING_RUN" | jq -r '.conclusion' 2>/dev/null)
            RUN_ID=$(echo "$MATCHING_RUN" | jq -r '.databaseId' 2>/dev/null)

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "CI workflow completed successfully for ${COMMIT_SHA:0:7}"
                return 0
            else
                log_error "CI workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                log_error "View logs with: gh run view $RUN_ID --log"

                # Show failed job details
                if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
                    log_error "Failed job logs:"
                    gh run view "$RUN_ID" --log-failed || true
                fi

                exit 1
            fi
        fi

        # Workflow still in progress
        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    echo ""  # Newline after progress dots
    log_error "Timeout waiting for CI workflow (exceeded 10 minutes)"
    log_error "Commit SHA: $COMMIT_SHA"
    log_warning "Check status manually: gh run watch"
    exit 1
}

# Wait for Publish to npm workflow after creating GitHub Release
# PHASE 1.2: Increased timeout to 10 minutes + filter by tag commit SHA
wait_for_workflow() {
    local VERSION=$1
    local MAX_WAIT=600  # PHASE 1.2: 10 minutes (up from 5 minutes)
    local ELAPSED=0

    log_info "Waiting for GitHub Actions 'Publish to npm' workflow..."
    log_info "  Version: v$VERSION (timeout: 10 minutes)"

    sleep 5  # Give GitHub a moment to register the tag

    # PHASE 1.2: Get the commit SHA for the tag to filter workflows
    local TAG_SHA
    TAG_SHA=$(git rev-list -n 1 "v$VERSION" 2>/dev/null || echo "")
    if [ -n "$TAG_SHA" ]; then
        log_info "  Tag commit: ${TAG_SHA:0:7}"
    fi

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # PHASE 1.2: Get workflow runs with SHA filtering when possible
        WORKFLOW_JSON=$(gh run list --workflow=publish.yml --limit 5 --json status,conclusion,headSha,databaseId 2>/dev/null || echo "[]")

        # PHASE 1.2: Find the workflow run matching our tag commit SHA
        # WHY use first(): jq '.[] | select()' returns multiple objects on separate lines
        # which breaks subsequent jq parsing. 'first()' returns valid JSON.
        local MATCHING_RUN=""
        if [ -n "$TAG_SHA" ]; then
            MATCHING_RUN=$(echo "$WORKFLOW_JSON" | jq -r --arg sha "$TAG_SHA" 'first(.[] | select(.headSha == $sha))' 2>/dev/null)
        fi

        # Fallback to latest workflow if no SHA match (for backwards compatibility)
        if [ -z "$MATCHING_RUN" ] || [ "$MATCHING_RUN" = "null" ]; then
            MATCHING_RUN=$(echo "$WORKFLOW_JSON" | jq -r '.[0]' 2>/dev/null)
        fi

        if [ -z "$MATCHING_RUN" ] || [ "$MATCHING_RUN" = "null" ]; then
            echo -n "."
            sleep 5
            ELAPSED=$((ELAPSED + 5))
            continue
        fi

        WORKFLOW_STATUS=$(echo "$MATCHING_RUN" | jq -r '.status' 2>/dev/null)

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            echo ""  # Newline after progress dots
            WORKFLOW_CONCLUSION=$(echo "$MATCHING_RUN" | jq -r '.conclusion' 2>/dev/null)
            RUN_ID=$(echo "$MATCHING_RUN" | jq -r '.databaseId' 2>/dev/null)

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "Publish workflow completed successfully"
                return 0
            else
                log_error "Publish workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                log_error "View logs with: gh run view $RUN_ID --log"

                # Show failed job details
                if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
                    log_error "Failed job logs:"
                    gh run view "$RUN_ID" --log-failed || true
                fi

                exit 1
            fi
        fi

        # Workflow still in progress
        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    echo ""  # Newline after progress dots
    log_error "Timeout waiting for Publish workflow (exceeded 10 minutes)"
    log_error "Version: v$VERSION"
    log_warning "Check status manually: gh run watch"
    exit 1
}

# Verify npm publication
# PHASE 1.3: 5 minute total timeout with exponential backoff retry logic
verify_npm_publication() {
    local VERSION=$1
    local MAX_WAIT=300   # PHASE 1.3: 5 minutes total timeout
    local ELAPSED=0
    local BACKOFF=5      # Start with 5 second intervals
    local MAX_BACKOFF=30 # Cap at 30 second intervals
    local ATTEMPT=1

    log_info "Verifying npm publication..."
    log_info "  Waiting for ${PACKAGE_NAME}@$VERSION to appear on registry..."

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Check npm registry for the version
        NPM_VERSION=$(npm view "${PACKAGE_NAME}@$VERSION" version 2>/dev/null || echo "")

        if [ "$NPM_VERSION" = "$VERSION" ]; then
            echo ""  # Newline after progress dots
            log_success "Package ${PACKAGE_NAME}@$VERSION is live on npm!"
            log_success "Install with: npm install ${PACKAGE_NAME}@$VERSION"
            return 0
        fi

        # PHASE 1.3: Exponential backoff (5s → 10s → 20s → 30s cap)
        echo -n "."
        sleep $BACKOFF
        ELAPSED=$((ELAPSED + BACKOFF))
        ATTEMPT=$((ATTEMPT + 1))

        # Double the backoff for next iteration, capped at MAX_BACKOFF
        if [ $BACKOFF -lt $MAX_BACKOFF ]; then
            BACKOFF=$((BACKOFF * 2))
            if [ $BACKOFF -gt $MAX_BACKOFF ]; then
                BACKOFF=$MAX_BACKOFF
            fi
        fi
    done

    echo ""  # Newline after progress dots
    log_error "Package ${PACKAGE_NAME}@$VERSION not found on npm after 5 minutes"
    log_warning "npm registry propagation may still be in progress"
    log_warning "Check manually: npm view ${PACKAGE_NAME}@$VERSION version"
    log_info "If the version appears later, the release was successful"
    exit 1
}

# Verify post-publish installation
# PHASE 1.4: Test that the published package actually works after npm install
# This catches packaging bugs like missing files in package.json "files" array
verify_post_publish_installation() {
    local VERSION=$1
    local TEMP_DIR

    log_info "Verifying package installation in clean environment..."

    # Create isolated temp directory (simulates fresh user environment)
    TEMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'svg-bbox-verify')
    log_info "  Test directory: $TEMP_DIR"

    # Trap to ensure cleanup on exit
    # WHY expand TEMP_DIR immediately: We want the current value of TEMP_DIR to be
    # captured at trap definition time, not at signal time. Double quotes cause
    # immediate expansion which is correct behavior here.
    # shellcheck disable=SC2064
    trap "rm -rf '$TEMP_DIR'" EXIT

    # Initialize npm project
    log_info "  → Initializing npm project..."
    if ! (cd "$TEMP_DIR" && npm init -y >/dev/null 2>&1); then
        log_warning "npm init failed in temp directory"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 0  # Non-fatal: package is already on npm, just can't verify
    fi

    # Install package from registry (not local tarball)
    log_info "  → Installing ${PACKAGE_NAME}@$VERSION from npm registry..."
    if ! (cd "$TEMP_DIR" && npm install "${PACKAGE_NAME}@$VERSION" --no-save 2>&1 | tail -5); then
        log_warning "npm install failed - package may not be fully propagated yet"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 0  # Non-fatal: registry may still be propagating
    fi

    local INSTALLED_PATH="$TEMP_DIR/node_modules/${PACKAGE_NAME}"

    # Verify package exists
    if [ ! -d "$INSTALLED_PATH" ]; then
        log_error "Package not found at $INSTALLED_PATH after install"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 1
    fi

    # PHASE 1.4: Test that require('svg-bbox') loads without MODULE_NOT_FOUND
    log_info "  → Verifying require('svg-bbox') works..."
    REQUIRE_TEST=$(cd "$TEMP_DIR" && node -e "try { require('svg-bbox'); console.log('OK'); } catch(e) { console.log(e.code || e.message); process.exit(1); }" 2>&1)
    if [ "$REQUIRE_TEST" != "OK" ]; then
        log_error "require('svg-bbox') failed: $REQUIRE_TEST"
        log_error "This indicates a packaging bug - missing files or broken dependencies"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 1
    fi
    log_success "  require('svg-bbox') works"

    # PHASE 1.4: Test CLI tools with --help
    # All 13 CLI tools defined in package.json bin
    local CLI_TOOLS=(
        "svg-bbox"
        "sbb-getbbox"
        "sbb-chrome-getbbox"
        "sbb-inkscape-getbbox"
        "sbb-extract"
        "sbb-chrome-extract"
        "sbb-inkscape-extract"
        "sbb-svg2png"
        "sbb-fix-viewbox"
        "sbb-compare"
        "sbb-test"
        "sbb-inkscape-text2path"
        "sbb-inkscape-svg2png"
    )

    log_info "  → Testing CLI tools with --help..."
    local FAILED_TOOLS=""

    for TOOL in "${CLI_TOOLS[@]}"; do
        local TOOL_PATH="$INSTALLED_PATH/${TOOL}.cjs"

        # Check if tool file exists
        if [ ! -f "$TOOL_PATH" ]; then
            FAILED_TOOLS="${FAILED_TOOLS}${TOOL} (file missing) "
            continue
        fi

        # Run tool with --help in subshell (some tools may call process.exit)
        # We only care that it doesn't throw MODULE_NOT_FOUND
        HELP_OUTPUT=$(cd "$TEMP_DIR" && timeout 10 node "$TOOL_PATH" --help 2>&1 || echo "TIMEOUT_OR_ERROR")

        # Check for MODULE_NOT_FOUND errors
        if echo "$HELP_OUTPUT" | grep -q "MODULE_NOT_FOUND\|Cannot find module"; then
            FAILED_TOOLS="${FAILED_TOOLS}${TOOL} (missing deps) "
        fi
    done

    if [ -n "$FAILED_TOOLS" ]; then
        log_error "Some CLI tools failed verification: $FAILED_TOOLS"
        log_error "This indicates missing files in package.json 'files' array"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 1
    fi

    log_success "  All ${#CLI_TOOLS[@]} CLI tools verified"

    # Cleanup
    rm -rf "$TEMP_DIR"
    trap - EXIT

    log_success "Post-publish installation verification passed"
    return 0
}

# Rollback on failure
# Uses state tracking variables to determine what needs to be cleaned up
rollback_release() {
    local VERSION=$1
    local STEP=$2

    log_error "Release failed at step: $STEP"
    log_warning "Attempting rollback..."

    # ROLLBACK STRATEGY based on state tracking:
    # 1. If tag pushed or release created → CANNOT auto-rollback (too dangerous)
    # 2. If commits pushed but tag not pushed → CANNOT auto-rollback (might break CI)
    # 3. If only local changes → CAN auto-rollback safely

    # Check if we've pushed anything to remote
    if [ "$TAG_PUSHED" = true ] || [ "$RELEASE_CREATED" = true ] || [ "$COMMITS_PUSHED" = true ]; then
        log_error "CANNOT auto-rollback: Changes were pushed to remote"
        log_warning "Manual cleanup required:"

        if [ "$RELEASE_CREATED" = true ] && [ -n "$VERSION" ]; then
            log_warning "  1. Delete GitHub Release:"
            log_warning "     gh release delete v$VERSION --yes"
        fi

        if [ "$TAG_PUSHED" = true ] && [ -n "$VERSION" ]; then
            log_warning "  2. Delete remote tag:"
            log_warning "     git push origin :refs/tags/v$VERSION"
        fi

        if [ "$COMMITS_PUSHED" = true ]; then
            log_warning "  3. Revert pushed commits (DANGEROUS - coordinate with team):"
            log_warning "     git reset --hard origin/main~1 && git push --force"
        fi

        log_warning "  4. Restore local state:"
        log_warning "     git fetch origin && git reset --hard origin/main"

        exit 1
    fi

    # Safe to auto-rollback: nothing was pushed to remote
    log_info "Safe to auto-rollback (no remote changes)"

    # Delete local tag if it exists
    # WHY: Tag is useless if release failed, and will block future attempts
    if [ "$TAG_CREATED" = true ] && [ -n "$CURRENT_TAG" ]; then
        log_info "  → Deleting local tag $CURRENT_TAG..."
        git tag -d "$CURRENT_TAG" 2>/dev/null || true
    fi

    # Reset to origin/main if commits were made locally
    # WHY: Removes version bump commit that never made it to remote
    if git log origin/main..HEAD --oneline 2>/dev/null | grep -q "chore(release): Bump version"; then
        log_info "  → Resetting to origin/main..."
        git reset --hard origin/main 2>/dev/null || true
    fi

    # Restore package.json and pnpm-lock.yaml if modified but not committed
    # WHY: Removes uncommitted version changes
    if git diff --name-only 2>/dev/null | grep -qE "package.json|pnpm-lock.yaml"; then
        log_info "  → Restoring package.json and pnpm-lock.yaml..."
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
    fi

    log_warning "Rollback complete. Repository restored to clean state."
    exit 1
}

# Main release function
main() {
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "  ${PACKAGE_NAME} Release Script" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "" >&2

    # Parse arguments
    SKIP_CONFIRMATION=false
    VERSION_ARG=""

    while [[ $# -gt 0 ]]; do
        case $1 in
            --yes|-y)
                SKIP_CONFIRMATION=true
                shift
                ;;
            --verbose|-v)
                VERBOSE=true
                log_verbose "Verbose mode enabled"
                shift
                ;;
            *)
                VERSION_ARG=$1
                shift
                ;;
        esac
    done

    if [ -z "$VERSION_ARG" ]; then
        log_error "Usage: $0 [--yes] [--verbose] [version|patch|minor|major]"
        log_info "Examples:"
        log_info "  $0 1.0.11            # Specific version"
        log_info "  $0 patch             # Bump patch (1.0.10 → 1.0.11)"
        log_info "  $0 minor             # Bump minor (1.0.10 → 1.1.0)"
        log_info "  $0 major             # Bump major (1.0.10 → 2.0.0)"
        log_info "  $0 --yes patch       # Skip confirmation prompt"
        log_info "  $0 --verbose patch   # Enable debug logging"
        exit 1
    fi

    # ══════════════════════════════════════════════════════════════════
    # PHASE 1.8: PRE-FLIGHT CHECKLIST
    # Consolidates all pre-release validations for clear visibility
    # WHY: Catch CI/CD issues BEFORE pushing to avoid wasted releases
    # ══════════════════════════════════════════════════════════════════
    show_preflight_header

    local PREFLIGHT_CHECKS=0
    local PREFLIGHT_TOTAL=9

    # Pre-flight Check 1: Prerequisites (commands and auth)
    log_info "[1/9] Checking required tools and authentication..."
    validate_prerequisites
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 2: Clean working directory
    log_info "[2/9] Checking working directory..."
    check_clean_working_dir
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 3: On main branch
    log_info "[3/9] Checking current branch..."
    check_main_branch
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 4: Branch synced with remote
    # WHY: Prevents push failures and ensures we're releasing the correct state
    log_info "[4/9] Checking branch synchronization..."
    check_branch_synced
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 5: GitHub workflow files exist
    # WHY: Release depends on ci.yml and publish.yml - fail fast if missing
    log_info "[5/9] Checking GitHub workflow files..."
    check_workflow_files_exist
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 6: Network connectivity
    # WHY: Both GitHub API and npm registry must be reachable for release
    log_info "[6/9] Checking network connectivity..."
    check_network_connectivity
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 7: Node.js version compatibility
    # WHY: npm trusted publishing requires npm 11.5.1+ (Node.js 24+)
    log_info "[7/9] Checking Node.js version..."
    check_node_version
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 8: Version synchronization (PHASE 1.5)
    log_info "[8/9] Validating version synchronization..."
    validate_version_sync || exit 1
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 9: UMD wrapper syntax (PHASE 1.6)
    log_info "[9/9] Validating UMD wrapper syntax..."
    validate_umd_wrapper || exit 1
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    show_preflight_summary $PREFLIGHT_CHECKS $PREFLIGHT_TOTAL

    # ══════════════════════════════════════════════════════════════════
    # VERSION DETERMINATION
    # ══════════════════════════════════════════════════════════════════

    # Get current version
    CURRENT_VERSION=$(get_current_version)
    log_info "Current version: $CURRENT_VERSION"

    # Determine new version
    case $VERSION_ARG in
        patch|minor|major)
            NEW_VERSION=$(bump_version "$VERSION_ARG")
            ;;
        *)
            NEW_VERSION=$(set_version "$VERSION_ARG")
            ;;
    esac

    echo "" >&2
    log_info "Release version: $NEW_VERSION"
    echo "" >&2

    # ══════════════════════════════════════════════════════════════════
    # VERSION-DEPENDENT CHECKS (require knowing the target version)
    # ══════════════════════════════════════════════════════════════════

    # Check if version already published on npm (idempotency)
    log_info "Checking npm registry for existing version..."
    EXISTING_NPM_VERSION=$(npm view "${PACKAGE_NAME}" version 2>/dev/null || echo "")
    if [ "$EXISTING_NPM_VERSION" = "$NEW_VERSION" ]; then
        log_warning "Version $NEW_VERSION is already published on npm"
        log_info "Skipping release (idempotent)"
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 0
    fi
    log_success "Version $NEW_VERSION not yet published on npm"

    # PHASE 1.8: Check if git tag already exists (prevents duplicate releases)
    log_info "Checking for existing git tag..."
    if ! check_tag_not_exists "$NEW_VERSION"; then
        log_error "Cannot proceed - tag already exists"
        log_info "Restoring package.json..."
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 1
    fi
    log_success "Git tag v$NEW_VERSION does not exist"

    # ══════════════════════════════════════════════════════════════════
    # USER CONFIRMATION
    # ══════════════════════════════════════════════════════════════════

    # Confirm with user (unless --yes flag)
    if [ "$SKIP_CONFIRMATION" = false ]; then
        read -p "$(echo -e "${YELLOW}Do you want to release v${NEW_VERSION}? [y/N]${NC} ")" -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_warning "Release cancelled"
            git checkout package.json pnpm-lock.yaml 2>/dev/null || true
            exit 0
        fi
    else
        log_info "Skipping confirmation (--yes flag)"
    fi

    # ══════════════════════════════════════════════════════════════════
    # QUALITY CHECKS AND AUTO-FIX
    # ══════════════════════════════════════════════════════════════════

    # Auto-fix common issues
    auto_fix_issues || rollback_release "$NEW_VERSION" "auto-fix"

    # Run quality checks (lint, typecheck, tests)
    run_quality_checks || rollback_release "$NEW_VERSION" "quality-checks"

    # ══════════════════════════════════════════════════════════════════
    # RELEASE EXECUTION
    # ══════════════════════════════════════════════════════════════════

    # Get previous tag for release notes
    PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    # Generate release notes
    generate_release_notes "$NEW_VERSION" "$PREVIOUS_TAG" || rollback_release "$NEW_VERSION" "release-notes"

    # Commit version bump
    commit_version_bump "$NEW_VERSION" || rollback_release "$NEW_VERSION" "commit-version"

    # Create git tag (locally only, don't push yet)
    create_git_tag "$NEW_VERSION" || rollback_release "$NEW_VERSION" "create-tag"

    # Push commits to GitHub (tag stays local)
    push_commits_to_github || rollback_release "$NEW_VERSION" "push-commits"

    # Create GitHub Release (THIS pushes the tag and triggers the workflow)
    # CRITICAL: This is the correct order - Release BEFORE workflow runs
    # gh release create will push the tag, which triggers the workflow
    create_github_release "$NEW_VERSION" || rollback_release "$NEW_VERSION" "create-release"

    # ══════════════════════════════════════════════════════════════════
    # VERIFICATION
    # ══════════════════════════════════════════════════════════════════

    # Wait for GitHub Actions workflow
    wait_for_workflow "$NEW_VERSION" || rollback_release "$NEW_VERSION" "workflow-wait"

    # Verify npm publication
    verify_npm_publication "$NEW_VERSION" || rollback_release "$NEW_VERSION" "npm-verify"

    # PHASE 1.4 - Verify package works after installation
    # This catches packaging bugs like missing files in package.json "files" array
    verify_post_publish_installation "$NEW_VERSION" || log_warning "Post-publish verification had issues (non-fatal)"

    # Success!
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    log_success "Release v$NEW_VERSION completed successfully!"
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "" >&2
    log_info "GitHub Release: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$NEW_VERSION"
    log_info "npm Package: https://www.npmjs.com/package/${PACKAGE_NAME}"
    log_info "Install: npm install ${PACKAGE_NAME}@$NEW_VERSION"
    echo "" >&2

    # Note: Cleanup is handled by the EXIT trap (handle_exit function)
}

# Run main function
main "$@"
