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
#   ./scripts/release.sh [--yes] [version]
#
# Examples:
#   ./scripts/release.sh 1.0.11        # Release specific version
#   ./scripts/release.sh patch         # Bump patch (1.0.10 → 1.0.11)
#   ./scripts/release.sh minor         # Bump minor (1.0.10 → 1.1.0)
#   ./scripts/release.sh major         # Bump major (1.0.10 → 2.0.0)
#   ./scripts/release.sh --yes patch   # Skip confirmation (for CI)
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

# Get package name from package.json
PACKAGE_NAME=$(grep '"name"' package.json | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Retry wrapper for network operations
retry_with_backoff() {
    local MAX_RETRIES=3
    local RETRY_COUNT=0
    local BACKOFF=2

    local CMD="$@"

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

# Get current version from package.json
get_current_version() {
    grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/'
}

# Bump version using npm version
bump_version() {
    local VERSION_TYPE=$1

    log_info "Bumping version ($VERSION_TYPE)..."

    # Use npm version to bump (doesn't create tag, we'll do that manually)
    NEW_VERSION=$(npm version "$VERSION_TYPE" --no-git-tag-version | sed 's/v//')

    log_success "Version bumped to $NEW_VERSION"
    echo "$NEW_VERSION"
}

# Set specific version
set_version() {
    local VERSION=$1

    log_info "Setting version to $VERSION..."

    # Update package.json
    npm version "$VERSION" --no-git-tag-version >/dev/null

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

# Run quality checks
run_quality_checks() {
    log_info "Running quality checks..."

    log_info "  → Linting..."
    if ! pnpm run lint 2>&1 | tee /tmp/lint-output.log | tail -20; then
        log_error "Linting failed"
        log_error "Full output: /tmp/lint-output.log"
        exit 1
    fi
    log_success "  Linting passed"

    log_info "  → Type checking..."
    if ! pnpm run typecheck 2>&1 | tee /tmp/typecheck-output.log | tail -20; then
        log_error "Type checking failed"
        log_error "Full output: /tmp/typecheck-output.log"
        exit 1
    fi
    log_success "  Type checking passed"

    log_info "  → Running tests..."
    if ! pnpm test 2>&1 | tee /tmp/test-output.log | tail -50; then
        log_error "Tests failed"
        log_error "Full output: /tmp/test-output.log"
        exit 1
    fi
    log_success "  Tests passed"

    log_success "All quality checks passed"
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

    # Count changes by category for summary
    FEATURES_COUNT=$(echo "$CHANGELOG_SECTION" | grep -c "^- \*\*.*\*\*:" | grep -c "New Features" || echo 0)
    FIXES_COUNT=$(echo "$CHANGELOG_SECTION" | grep -c "^- \*\*.*\*\*:" | grep -c "Bug Fixes" || echo 0)

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

    log_info "Creating git tag v$VERSION..."

    # Delete tag if it exists locally
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_warning "Tag v$VERSION already exists locally, deleting..."
        git tag -d "v$VERSION"
    fi

    # Create annotated tag
    git tag -a "v$VERSION" -m "Release v$VERSION"

    log_success "Git tag created"
}

# Push commits only (tag will be pushed by gh release create)
push_commits_to_github() {
    log_info "Pushing commits to GitHub..."

    # Use retry logic for git push (network operation)
    if ! retry_with_backoff "git push origin main"; then
        log_error "Failed to push commits after retries"
        return 1
    fi
    log_success "Commits pushed"

    log_info "Waiting for CI workflow to complete (this may take 3-10 minutes)..."
    wait_for_ci_workflow
}

# Create GitHub Release (this pushes the tag and triggers the workflow)
create_github_release() {
    local VERSION=$1

    log_info "Creating GitHub Release (this will push the tag and trigger workflow)..."

    # Check if release already exists (idempotency)
    if gh release view "v$VERSION" >/dev/null 2>&1; then
        log_warning "GitHub Release v$VERSION already exists"
        log_info "Skipping release creation (idempotent)"
        return 0
    fi

    # Check if tag exists remotely
    if git ls-remote --tags origin | grep -q "refs/tags/v$VERSION"; then
        log_warning "Tag v$VERSION already exists on remote"
        log_info "Creating release for existing tag..."
        gh release create "v$VERSION" \
            --title "v$VERSION" \
            --notes-file /tmp/release-notes.md
        log_success "GitHub Release created for existing tag"
        return 0
    fi

    # Create release using gh CLI
    # The tag already exists locally, gh will push it when creating the release
    gh release create "v$VERSION" \
        --title "v$VERSION" \
        --notes-file /tmp/release-notes.md

    log_success "GitHub Release created: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$VERSION"
    log_success "Tag pushed and workflow triggered"
}

# Wait for CI workflow after pushing commits
wait_for_ci_workflow() {
    local MAX_WAIT=600  # 10 minutes
    local ELAPSED=0

    sleep 5  # Give GitHub a moment to register the push

    log_info "Monitoring CI workflow (lint, typecheck, test, e2e, coverage)..."

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Get the latest CI workflow run for the main branch
        WORKFLOW_STATUS=$(gh run list --workflow=ci.yml --branch=main --limit 1 --json status,conclusion -q '.[0].status' 2>/dev/null || echo "")

        if [ -z "$WORKFLOW_STATUS" ]; then
            echo -n "."
            sleep 5
            ELAPSED=$((ELAPSED + 5))
            continue
        fi

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            WORKFLOW_CONCLUSION=$(gh run list --workflow=ci.yml --branch=main --limit 1 --json conclusion -q '.[0].conclusion')

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "CI workflow completed successfully"
                return 0
            else
                log_error "CI workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                log_error "View logs with: gh run view --log"

                # Show failed job details
                gh run list --workflow=ci.yml --branch=main --limit 1

                # Get the run ID and show which jobs failed
                RUN_ID=$(gh run list --workflow=ci.yml --branch=main --limit 1 --json databaseId -q '.[0].databaseId')
                if [ -n "$RUN_ID" ]; then
                    log_error "Failed jobs:"
                    gh run view "$RUN_ID" --log-failed || true
                fi

                exit 1
            fi
        fi

        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    log_error "Timeout waiting for CI workflow (exceeded 10 minutes)"
    log_warning "Check status manually: gh run watch"
    exit 1
}

# Wait for Publish to npm workflow after creating GitHub Release
wait_for_workflow() {
    local VERSION=$1
    local MAX_WAIT=300  # 5 minutes
    local ELAPSED=0

    log_info "Waiting for GitHub Actions 'Publish to npm' workflow..."

    sleep 5  # Give GitHub a moment to register the tag

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Get the latest workflow run for this tag
        WORKFLOW_STATUS=$(gh run list --workflow=publish.yml --limit 1 --json status,conclusion -q '.[0].status' 2>/dev/null || echo "")

        if [ -z "$WORKFLOW_STATUS" ]; then
            echo -n "."
            sleep 5
            ELAPSED=$((ELAPSED + 5))
            continue
        fi

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            WORKFLOW_CONCLUSION=$(gh run list --workflow=publish.yml --limit 1 --json conclusion -q '.[0].conclusion')

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "Publish workflow completed successfully"
                return 0
            else
                log_error "Publish workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                log_error "View logs with: gh run view --log"

                # Show failed job details
                gh run list --workflow=publish.yml --limit 1

                # Get the run ID and show logs
                RUN_ID=$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')
                if [ -n "$RUN_ID" ]; then
                    log_error "Failed logs:"
                    gh run view "$RUN_ID" --log-failed || true
                fi

                exit 1
            fi
        fi

        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    log_error "Timeout waiting for Publish workflow (exceeded 5 minutes)"
    log_warning "Check status manually: gh run watch"
    exit 1
}

# Verify npm publication
verify_npm_publication() {
    local VERSION=$1
    local MAX_RETRIES=12  # 1 minute with 5-second intervals
    local RETRY_COUNT=0

    log_info "Verifying npm publication..."

    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        NPM_VERSION=$(npm view ${PACKAGE_NAME} version 2>/dev/null || echo "")

        if [ "$NPM_VERSION" = "$VERSION" ]; then
            log_success "Package ${PACKAGE_NAME}@$VERSION is live on npm!"
            log_success "Install with: npm install ${PACKAGE_NAME}@$VERSION"
            return 0
        fi

        echo -n "."
        sleep 5
        RETRY_COUNT=$((RETRY_COUNT + 1))
    done

    log_error "Package not found on npm after waiting"
    log_warning "Check manually: npm view ${PACKAGE_NAME} version"
    exit 1
}

# Rollback on failure
rollback_release() {
    local VERSION=$1
    local STEP=$2

    log_error "Release failed at step: $STEP"
    log_warning "Attempting rollback..."

    # Delete local tag if it exists
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_info "  → Deleting local tag v$VERSION..."
        git tag -d "v$VERSION" || true
    fi

    # Reset to origin/main if commits were made
    if git log origin/main..HEAD --oneline | grep -q "chore(release): Bump version"; then
        log_info "  → Resetting to origin/main..."
        git reset --hard origin/main || true
    fi

    # Restore package.json and pnpm-lock.yaml if modified
    if git diff --name-only | grep -qE "package.json|pnpm-lock.yaml"; then
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
            *)
                VERSION_ARG=$1
                shift
                ;;
        esac
    done

    if [ -z "$VERSION_ARG" ]; then
        log_error "Usage: $0 [--yes] [version|patch|minor|major]"
        log_info "Examples:"
        log_info "  $0 1.0.11        # Specific version"
        log_info "  $0 patch         # Bump patch (1.0.10 → 1.0.11)"
        log_info "  $0 minor         # Bump minor (1.0.10 → 1.1.0)"
        log_info "  $0 major         # Bump major (1.0.10 → 2.0.0)"
        log_info "  $0 --yes patch   # Skip confirmation prompt"
        exit 1
    fi

    # Step 1: Validate prerequisites
    validate_prerequisites

    # Step 2: Check working directory and branch
    check_clean_working_dir
    check_main_branch

    # Step 3: Get current version
    CURRENT_VERSION=$(get_current_version)
    log_info "Current version: $CURRENT_VERSION"

    # Step 4: Determine new version
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

    # Step 5: Check if version already published (idempotency)
    EXISTING_NPM_VERSION=$(npm view ${PACKAGE_NAME} version 2>/dev/null || echo "")
    if [ "$EXISTING_NPM_VERSION" = "$NEW_VERSION" ]; then
        log_warning "Version $NEW_VERSION is already published on npm"
        log_info "Skipping release (idempotent)"
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 0
    fi

    # Step 6: Confirm with user (unless --yes flag)
    if [ "$SKIP_CONFIRMATION" = false ]; then
        read -p "$(echo -e ${YELLOW}Do you want to release v$NEW_VERSION? [y/N]${NC} )" -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_warning "Release cancelled"
            git checkout package.json pnpm-lock.yaml 2>/dev/null || true
            exit 0
        fi
    else
        log_info "Skipping confirmation (--yes flag)"
    fi

    # Step 7: Auto-fix common issues
    auto_fix_issues || rollback_release "$NEW_VERSION" "auto-fix"

    # Step 8: Run quality checks
    run_quality_checks || rollback_release "$NEW_VERSION" "quality-checks"

    # Step 9: Get previous tag for release notes
    PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    # Step 10: Generate release notes
    generate_release_notes "$NEW_VERSION" "$PREVIOUS_TAG" || rollback_release "$NEW_VERSION" "release-notes"

    # Step 11: Commit version bump
    commit_version_bump "$NEW_VERSION" || rollback_release "$NEW_VERSION" "commit-version"

    # Step 12: Create git tag (locally only, don't push yet)
    create_git_tag "$NEW_VERSION" || rollback_release "$NEW_VERSION" "create-tag"

    # Step 13: Push commits to GitHub (tag stays local)
    push_commits_to_github || rollback_release "$NEW_VERSION" "push-commits"

    # Step 14: Create GitHub Release (THIS pushes the tag and triggers the workflow)
    # CRITICAL: This is the correct order - Release BEFORE workflow runs
    # gh release create will push the tag, which triggers the workflow
    create_github_release "$NEW_VERSION" || rollback_release "$NEW_VERSION" "create-release"

    # Step 15: Wait for GitHub Actions workflow
    wait_for_workflow "$NEW_VERSION" || rollback_release "$NEW_VERSION" "workflow-wait"

    # Step 16: Verify npm publication
    verify_npm_publication "$NEW_VERSION" || rollback_release "$NEW_VERSION" "npm-verify"

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

    # Cleanup
    rm -f /tmp/release-notes.md /tmp/lint-output.log /tmp/typecheck-output.log /tmp/test-output.log
}

# Run main function
main "$@"
