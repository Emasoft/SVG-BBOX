#!/bin/bash
#
# Release Script for svg-bbox
#
# Proper sequence: GitHub Release → npm publish
#
# This script automates the release process with the correct order of operations:
# 1. Validate environment and prerequisites
# 2. Run all quality checks (lint, typecheck, tests)
# 3. Create git tag
# 4. Create GitHub Release (FIRST - this triggers the workflow)
# 5. Wait for GitHub Actions to publish to npm
# 6. Verify npm publication
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

# Generate release notes
generate_release_notes() {
    local VERSION=$1
    local PREVIOUS_TAG=$2

    log_info "Generating release notes..."

    # Get commit range
    if [ -z "$PREVIOUS_TAG" ]; then
        COMMITS=$(git log --pretty=format:"- %s" --no-merges)
    else
        COMMITS=$(git log "$PREVIOUS_TAG"..HEAD --pretty=format:"- %s" --no-merges)
    fi

    # Create release notes
    cat > /tmp/release-notes.md <<EOF
## ${PACKAGE_NAME} v${VERSION}

### Changes

${COMMITS}

### Test Results
- All tests passing: ✅
- Linting: ✅ 0 errors
- Type checking: ✅ 0 errors

### Installation

\`\`\`bash
npm install ${PACKAGE_NAME}@${VERSION}
\`\`\`
EOF

    log_success "Release notes generated"
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

# Push commits and tag
push_to_github() {
    local VERSION=$1

    log_info "Pushing to GitHub..."

    # Push commits
    git push origin main
    log_success "Commits pushed"

    # Push tag
    git push origin "v$VERSION"
    log_success "Tag pushed"
}

# Create GitHub Release
create_github_release() {
    local VERSION=$1

    log_info "Creating GitHub Release..."

    # Create release using gh CLI
    gh release create "v$VERSION" \
        --title "v$VERSION" \
        --notes-file /tmp/release-notes.md \
        --verify-tag

    log_success "GitHub Release created: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$VERSION"
}

# Wait for GitHub Actions workflow
wait_for_workflow() {
    local VERSION=$1
    local MAX_WAIT=300  # 5 minutes
    local ELAPSED=0

    log_info "Waiting for GitHub Actions 'Publish to npm' workflow..."

    sleep 5  # Give GitHub a moment to register the tag

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Get the latest workflow run for this tag
        WORKFLOW_STATUS=$(gh run list --workflow=publish.yml --limit 1 --json status,conclusion -q '.[0].status')

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            WORKFLOW_CONCLUSION=$(gh run list --workflow=publish.yml --limit 1 --json conclusion -q '.[0].conclusion')

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "GitHub Actions workflow completed successfully"
                return 0
            else
                log_error "GitHub Actions workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                gh run list --workflow=publish.yml --limit 1
                exit 1
            fi
        fi

        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    log_error "Timeout waiting for GitHub Actions workflow"
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

    # Step 10: Create git tag
    create_git_tag "$NEW_VERSION"

    # Step 11: Push to GitHub
    push_to_github "$NEW_VERSION"

    # Step 12: Create GitHub Release (THIS TRIGGERS THE WORKFLOW)
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
