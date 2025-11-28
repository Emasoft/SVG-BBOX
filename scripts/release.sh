#!/bin/bash
#
# Release Script for svg-bbox
#
# CRITICAL: Proper sequence to avoid race conditions
#
# This script automates the release process with the CORRECT order:
# 1. Validate environment and prerequisites
# 2. Run all quality checks (lint, typecheck, tests)
# 3. Bump version in package.json and commit
# 4. Create git tag LOCALLY (don't push yet)
# 5. Push commits to GitHub (tag stays local)
# 6. Create GitHub Release → gh CLI pushes tag + creates release atomically
# 7. Tag push triggers GitHub Actions workflow
# 8. Wait for GitHub Actions to publish to npm (prepublishOnly hook runs in CI)
# 9. Verify npm publication
#
# Why this order matters:
# - Creating the GitHub Release BEFORE the workflow runs ensures release notes
#   are attached to the tag when the workflow executes
# - gh release create pushes the tag atomically with release creation
# - Avoids race condition where workflow starts before release exists
#
# Usage:
#   ./scripts/release.sh [version]
#
# Examples:
#   ./scripts/release.sh 1.0.11        # Release specific version
#   ./scripts/release.sh patch         # Bump patch version (1.0.10 → 1.0.11)
#   ./scripts/release.sh minor         # Bump minor version (1.0.10 → 1.1.0)
#   ./scripts/release.sh major         # Bump major version (1.0.10 → 2.0.0)
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
    echo -e "${BLUE}ℹ ${NC}$1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
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

# Run quality checks
run_quality_checks() {
    log_info "Running quality checks..."

    log_info "  → Linting..."
    if ! npm run lint >/dev/null 2>&1; then
        log_error "Linting failed"
        exit 1
    fi
    log_success "  Linting passed"

    log_info "  → Type checking..."
    if ! npm run typecheck >/dev/null 2>&1; then
        log_error "Type checking failed"
        exit 1
    fi
    log_success "  Type checking passed"

    log_info "  → Running tests..."
    if ! npm test >/dev/null 2>&1; then
        log_error "Tests failed"
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

    git push origin main
    log_success "Commits pushed"

    log_info "Waiting for CI workflow to complete (this may take 3-10 minutes)..."
    wait_for_ci_workflow
}

# Create GitHub Release (this pushes the tag and triggers the workflow)
create_github_release() {
    local VERSION=$1

    log_info "Creating GitHub Release (this will push the tag and trigger workflow)..."

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

# Main release function
main() {
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  ${PACKAGE_NAME} Release Script"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    # Parse arguments
    if [ $# -eq 0 ]; then
        log_error "Usage: $0 [version|patch|minor|major]"
        log_info "Examples:"
        log_info "  $0 1.0.11        # Specific version"
        log_info "  $0 patch         # Bump patch (1.0.10 → 1.0.11)"
        log_info "  $0 minor         # Bump minor (1.0.10 → 1.1.0)"
        log_info "  $0 major         # Bump major (1.0.10 → 2.0.0)"
        exit 1
    fi

    VERSION_ARG=$1

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

    echo ""
    log_info "Release version: $NEW_VERSION"
    echo ""

    # Step 5: Confirm with user
    read -p "$(echo -e ${YELLOW}Do you want to release v$NEW_VERSION? [y/N]${NC} )" -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Release cancelled"
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 0
    fi

    # Step 6: Run quality checks
    run_quality_checks

    # Step 7: Get previous tag for release notes
    PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    # Step 8: Generate release notes
    generate_release_notes "$NEW_VERSION" "$PREVIOUS_TAG"

    # Step 9: Commit version bump
    commit_version_bump "$NEW_VERSION"

    # Step 10: Create git tag (locally only, don't push yet)
    create_git_tag "$NEW_VERSION"

    # Step 11: Push commits to GitHub (tag stays local)
    push_commits_to_github

    # Step 12: Create GitHub Release (THIS pushes the tag and triggers the workflow)
    # CRITICAL: This is the correct order - Release BEFORE workflow runs
    # gh release create will push the tag, which triggers the workflow
    create_github_release "$NEW_VERSION"

    # Step 13: Wait for GitHub Actions workflow
    wait_for_workflow "$NEW_VERSION"

    # Step 14: Verify npm publication
    verify_npm_publication "$NEW_VERSION"

    # Success!
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    log_success "Release v$NEW_VERSION completed successfully!"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    log_info "GitHub Release: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$NEW_VERSION"
    log_info "npm Package: https://www.npmjs.com/package/${PACKAGE_NAME}"
    log_info "Install: npm install ${PACKAGE_NAME}@$NEW_VERSION"
    echo ""

    # Cleanup
    rm -f /tmp/release-notes.md
}

# Run main function
main "$@"
