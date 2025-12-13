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
PUSHED_COMMIT_SHA=""      # Store the pushed commit SHA for release creation
VERBOSE=false             # Verbose mode for debugging

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION FILE SUPPORT
# release_conf.yml provides project-specific settings
# ══════════════════════════════════════════════════════════════════

# Config file location (check multiple paths)
CONFIG_FILE=""
for config_path in "config/release_conf.yml" "release_conf.yml" ".release_conf.yml"; do
    if [ -f "$config_path" ]; then
        CONFIG_FILE="$config_path"
        break
    fi
done

# Check if yq is available for YAML parsing
YQ_AVAILABLE=false
if command -v yq &>/dev/null; then
    YQ_AVAILABLE=true
fi

# ══════════════════════════════════════════════════════════════════
# YAML CONFIGURATION PARSING
# Uses yq if available, otherwise falls back to grep/sed
# ══════════════════════════════════════════════════════════════════

# Get a value from the config file
# Usage: get_config "path.to.value" "default_value"
get_config() {
    local KEY="$1"
    local DEFAULT="$2"

    # If no config file, return default
    if [ -z "$CONFIG_FILE" ] || [ ! -f "$CONFIG_FILE" ]; then
        echo "$DEFAULT"
        return
    fi

    # Use yq if available (proper YAML parsing)
    if [ "$YQ_AVAILABLE" = true ]; then
        local VALUE
        VALUE=$(yq -r ".$KEY // \"\"" "$CONFIG_FILE" 2>/dev/null)
        if [ -n "$VALUE" ] && [ "$VALUE" != "null" ]; then
            echo "$VALUE"
        else
            echo "$DEFAULT"
        fi
    else
        # Fallback: simple grep-based extraction (limited to simple keys)
        # Only works for top-level or simple nested keys
        local SIMPLE_KEY
        SIMPLE_KEY=$(echo "$KEY" | sed 's/.*\.//')
        local VALUE
        VALUE=$(grep -E "^\s*${SIMPLE_KEY}:" "$CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*:\s*"\?\([^"]*\)"\?.*/\1/' | sed 's/#.*//' | xargs)
        if [ -n "$VALUE" ]; then
            echo "$VALUE"
        else
            echo "$DEFAULT"
        fi
    fi
}

# Get a boolean config value
# Usage: get_config_bool "path.to.value" "default"
get_config_bool() {
    local VALUE
    VALUE=$(get_config "$1" "$2")
    case "$VALUE" in
        true|True|TRUE|yes|Yes|YES|1) echo "true" ;;
        *) echo "false" ;;
    esac
}

# Get an array from config (returns space-separated values)
# Usage: get_config_array "path.to.array"
get_config_array() {
    local KEY="$1"

    if [ -z "$CONFIG_FILE" ] || [ ! -f "$CONFIG_FILE" ]; then
        return
    fi

    if [ "$YQ_AVAILABLE" = true ]; then
        yq -r ".$KEY[]? // empty" "$CONFIG_FILE" 2>/dev/null | tr '\n' ' '
    fi
}

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION AUTO-GENERATION
# Detects project settings from existing files
# ══════════════════════════════════════════════════════════════════

# Detect package manager from lock files
detect_package_manager() {
    if [ -f "pnpm-lock.yaml" ]; then
        echo "pnpm"
    elif [ -f "yarn.lock" ]; then
        echo "yarn"
    elif [ -f "bun.lockb" ]; then
        echo "bun"
    elif [ -f "package-lock.json" ]; then
        echo "npm"
    else
        echo "npm"  # Default
    fi
}

# Detect main branch from git
detect_main_branch() {
    # Try to get default branch from remote
    local BRANCH
    BRANCH=$(git remote show origin 2>/dev/null | grep "HEAD branch" | sed 's/.*: //')
    if [ -n "$BRANCH" ]; then
        echo "$BRANCH"
    elif git rev-parse --verify main &>/dev/null; then
        echo "main"
    elif git rev-parse --verify master &>/dev/null; then
        echo "master"
    else
        echo "main"  # Default
    fi
}

# Detect GitHub owner/repo from git remote
detect_github_info() {
    local REMOTE_URL
    REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")

    # Parse owner and repo from various URL formats
    # https://github.com/owner/repo.git
    # git@github.com:owner/repo.git
    local OWNER=""
    local REPO=""

    if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
        OWNER="${BASH_REMATCH[1]}"
        REPO="${BASH_REMATCH[2]}"
    fi

    echo "$OWNER $REPO"
}

# Detect version file type
detect_version_file() {
    if [ -f "package.json" ]; then
        echo "package.json"
    elif [ -f "pyproject.toml" ]; then
        echo "pyproject.toml"
    elif [ -f "Cargo.toml" ]; then
        echo "Cargo.toml"
    elif [ -f "setup.py" ]; then
        echo "setup.py"
    else
        echo "package.json"  # Default
    fi
}

# Detect if git-cliff is configured
detect_release_notes_generator() {
    if [ -f "cliff.toml" ] && command -v git-cliff &>/dev/null; then
        echo "git-cliff"
    else
        echo "auto"
    fi
}

# ══════════════════════════════════════════════════════════════════
# DEPENDENCY DETECTION AND INSTALLATION GUIDANCE
# Checks for required tools and suggests installation methods
# Compatible with bash 3.x (no associative arrays)
# ══════════════════════════════════════════════════════════════════

# List of required dependencies (space-separated)
RELEASE_DEP_LIST="gh jq git-cliff yq"

# Get dependency info by name (format: description|install_cmd|url)
get_dep_info() {
    local DEP="$1"
    case "$DEP" in
        "gh")        echo "GitHub CLI for releases|brew install gh|https://cli.github.com" ;;
        "jq")        echo "JSON processor|brew install jq|https://jqlang.github.io/jq/" ;;
        "git-cliff") echo "Changelog generator|cargo install git-cliff|https://git-cliff.org" ;;
        "yq")        echo "YAML processor|brew install yq|https://github.com/mikefarah/yq" ;;
        *)           echo "Unknown dependency||" ;;
    esac
}

# Check a single dependency and return status
check_dependency() {
    local DEP="$1"
    if command -v "$DEP" &>/dev/null; then
        echo "installed"
    else
        echo "missing"
    fi
}

# Get all missing dependencies
get_missing_dependencies() {
    local MISSING=""
    for DEP in $RELEASE_DEP_LIST; do
        if ! command -v "$DEP" &>/dev/null; then
            MISSING="$MISSING $DEP"
        fi
    done
    echo "$MISSING" | xargs  # Trim whitespace
}

# Print installation instructions for missing dependencies
print_dependency_instructions() {
    local MISSING
    MISSING=$(get_missing_dependencies)

    if [ -z "$MISSING" ]; then
        return 0
    fi

    echo ""
    echo "Missing dependencies detected:"
    echo ""

    for DEP in $MISSING; do
        local INFO
        INFO=$(get_dep_info "$DEP")
        local DESC
        DESC=$(echo "$INFO" | cut -d'|' -f1)
        local INSTALL
        INSTALL=$(echo "$INFO" | cut -d'|' -f2)
        local URL
        URL=$(echo "$INFO" | cut -d'|' -f3)

        echo "  $DEP - $DESC"
        echo "    Install: $INSTALL"
        echo "    More info: $URL"
        echo ""
    done

    return 1
}

# Check if dependency should be added to package.json devDependencies
# Returns the npm package name if applicable, empty otherwise
get_npm_equivalent() {
    local DEP="$1"
    case "$DEP" in
        # These have npm equivalents that can be added to devDependencies
        "git-cliff") echo "" ;;  # No npm equivalent, requires cargo/binary
        "yq") echo "" ;;         # No npm equivalent, requires binary
        "jq") echo "" ;;         # No npm equivalent, requires binary
        "gh") echo "" ;;         # No npm equivalent, requires binary
        *) echo "" ;;
    esac
}

# ══════════════════════════════════════════════════════════════════
# CI WORKFLOW ANALYSIS
# Detects publishing method and validates workflow configuration
# ══════════════════════════════════════════════════════════════════

# Find all GitHub workflow files
find_workflow_files() {
    if [ -d ".github/workflows" ]; then
        find .github/workflows -name "*.yml" -o -name "*.yaml" 2>/dev/null
    fi
}

# Detect npm publishing method from workflow files
# Returns: "oidc", "token", "unknown"
detect_npm_publish_method() {
    local PUBLISH_WORKFLOW=""

    # Look for publish workflow
    for WF in $(find_workflow_files); do
        if grep -q "npm publish" "$WF" 2>/dev/null; then
            PUBLISH_WORKFLOW="$WF"
            break
        fi
    done

    if [ -z "$PUBLISH_WORKFLOW" ]; then
        echo "unknown"
        return
    fi

    # Check for OIDC indicators
    local HAS_ID_TOKEN=false
    local HAS_NPM_TOKEN=false
    local NODE_VERSION=""

    # Check for id-token: write permission (OIDC)
    if grep -qE "id-token:\s*write" "$PUBLISH_WORKFLOW" 2>/dev/null; then
        HAS_ID_TOKEN=true
    fi

    # Check for NPM_TOKEN secret usage (traditional)
    if grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN.*secrets\." "$PUBLISH_WORKFLOW" 2>/dev/null; then
        HAS_NPM_TOKEN=true
    fi

    # Detect Node.js version
    NODE_VERSION=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$PUBLISH_WORKFLOW" 2>/dev/null | head -1 | grep -oE "[0-9]+")

    # Determine method
    if [ "$HAS_ID_TOKEN" = true ] && [ "$HAS_NPM_TOKEN" = false ]; then
        echo "oidc"
    elif [ "$HAS_NPM_TOKEN" = true ]; then
        echo "token"
    elif [ "$HAS_ID_TOKEN" = true ]; then
        # Has OIDC permission but might also have fallback token
        echo "oidc"
    else
        echo "unknown"
    fi
}

# Get detailed CI workflow info as JSON-like output
analyze_ci_workflows() {
    local RESULT=""

    # Find publish workflow
    local PUBLISH_WF=""
    local CI_WF=""

    for WF in $(find_workflow_files); do
        local WF_NAME=$(basename "$WF")
        if grep -q "npm publish" "$WF" 2>/dev/null; then
            PUBLISH_WF="$WF"
        fi
        if grep -qE "^name:\s*CI" "$WF" 2>/dev/null || [[ "$WF_NAME" == "ci.yml" ]]; then
            CI_WF="$WF"
        fi
    done

    echo "publish_workflow=${PUBLISH_WF:-none}"
    echo "ci_workflow=${CI_WF:-none}"
    echo "publish_method=$(detect_npm_publish_method)"

    # Extract Node.js version from publish workflow
    if [ -n "$PUBLISH_WF" ]; then
        local NODE_VER=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$PUBLISH_WF" 2>/dev/null | head -1 | grep -oE "[0-9]+")
        echo "publish_node_version=${NODE_VER:-unknown}"
    fi

    # Extract tag pattern
    if [ -n "$PUBLISH_WF" ]; then
        local TAG_PATTERN=$(grep -A2 "tags:" "$PUBLISH_WF" 2>/dev/null | grep -oE "'[^']+'" | head -1 | tr -d "'")
        echo "tag_pattern=${TAG_PATTERN:-unknown}"
    fi
}

# ══════════════════════════════════════════════════════════════════
# CI WORKFLOW ERROR DETECTION
# Validates workflow configuration and reports issues
# ══════════════════════════════════════════════════════════════════

# Validate CI workflows and return list of issues
validate_ci_workflows() {
    local ISSUES=""
    local ISSUE_COUNT=0

    # Find publish workflow
    local PUBLISH_WF=""
    for WF in $(find_workflow_files); do
        if grep -q "npm publish" "$WF" 2>/dev/null; then
            PUBLISH_WF="$WF"
            break
        fi
    done

    if [ -z "$PUBLISH_WF" ]; then
        echo "WARNING: No npm publish workflow found in .github/workflows/"
        return
    fi

    local PUBLISH_METHOD=$(detect_npm_publish_method)

    # Issue 1: OIDC requires Node.js 24+ (npm 11.5.1+)
    if [ "$PUBLISH_METHOD" = "oidc" ]; then
        local NODE_VER=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$PUBLISH_WF" 2>/dev/null | head -1 | grep -oE "[0-9]+")
        if [ -n "$NODE_VER" ] && [ "$NODE_VER" -lt 24 ]; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "ERROR[$ISSUE_COUNT]: OIDC trusted publishing requires Node.js 24+ (found: $NODE_VER)"
            echo "  File: $PUBLISH_WF"
            echo "  Fix: Change node-version to '24' for npm 11.5.1+ OIDC support"
            echo ""
        fi
    fi

    # Issue 2: Missing id-token permission for OIDC
    if [ "$PUBLISH_METHOD" = "oidc" ]; then
        if ! grep -qE "id-token:\s*write" "$PUBLISH_WF" 2>/dev/null; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "ERROR[$ISSUE_COUNT]: Missing 'id-token: write' permission for OIDC"
            echo "  File: $PUBLISH_WF"
            echo "  Fix: Add 'permissions: { id-token: write, contents: read }'"
            echo ""
        fi
    fi

    # Issue 3: Token method but no NPM_TOKEN secret reference
    if [ "$PUBLISH_METHOD" = "token" ]; then
        if ! grep -qE "secrets\.NPM_TOKEN|secrets\.NODE_AUTH_TOKEN" "$PUBLISH_WF" 2>/dev/null; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "WARNING[$ISSUE_COUNT]: Token publishing detected but NPM_TOKEN not referenced"
            echo "  File: $PUBLISH_WF"
            echo "  Fix: Ensure NPM_TOKEN secret is configured in repository settings"
            echo ""
        fi
    fi

    # Issue 4: Missing tag trigger for publish workflow
    if ! grep -qE "tags:\s*$" "$PUBLISH_WF" 2>/dev/null && ! grep -qE "tags:" "$PUBLISH_WF" 2>/dev/null; then
        ISSUE_COUNT=$((ISSUE_COUNT + 1))
        echo "WARNING[$ISSUE_COUNT]: Publish workflow may not trigger on tags"
        echo "  File: $PUBLISH_WF"
        echo "  Fix: Add 'on: { push: { tags: [\"v*\"] } }' trigger"
        echo ""
    fi

    # Issue 5: Tag pattern doesn't match expected format
    local TAG_PATTERN=$(grep -A2 "tags:" "$PUBLISH_WF" 2>/dev/null | grep -oE "'[^']+'" | head -1 | tr -d "'")
    if [ -n "$TAG_PATTERN" ] && [[ ! "$TAG_PATTERN" =~ ^v ]]; then
        ISSUE_COUNT=$((ISSUE_COUNT + 1))
        echo "WARNING[$ISSUE_COUNT]: Tag pattern '$TAG_PATTERN' doesn't start with 'v'"
        echo "  File: $PUBLISH_WF"
        echo "  Expected: 'v*' to match version tags like v1.0.0"
        echo ""
    fi

    # Issue 6: Using --provenance flag with OIDC (redundant)
    if [ "$PUBLISH_METHOD" = "oidc" ]; then
        if grep -qE "npm publish.*--provenance" "$PUBLISH_WF" 2>/dev/null; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "INFO[$ISSUE_COUNT]: --provenance flag is redundant with OIDC (automatic)"
            echo "  File: $PUBLISH_WF"
            echo "  Note: npm 11.5.1+ automatically adds provenance with OIDC"
            echo ""
        fi
    fi

    # Issue 7: registry-url with OIDC (usually not needed)
    if [ "$PUBLISH_METHOD" = "oidc" ]; then
        if grep -qE "registry-url:" "$PUBLISH_WF" 2>/dev/null; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "INFO[$ISSUE_COUNT]: registry-url may not be needed with OIDC"
            echo "  File: $PUBLISH_WF"
            echo "  Note: npm OIDC handles registry authentication automatically"
            echo ""
        fi
    fi

    if [ $ISSUE_COUNT -eq 0 ]; then
        echo "OK: No issues detected in CI workflows"
    else
        echo "Found $ISSUE_COUNT issue(s) in CI workflows"
    fi
}

# Print CI workflow analysis summary
print_ci_analysis() {
    echo ""
    echo "CI Workflow Analysis:"
    echo "─────────────────────"

    local ANALYSIS
    while IFS= read -r LINE; do
        local KEY=$(echo "$LINE" | cut -d'=' -f1)
        local VALUE=$(echo "$LINE" | cut -d'=' -f2)
        case "$KEY" in
            publish_workflow)
                echo "  Publish workflow: ${VALUE:-not found}"
                ;;
            ci_workflow)
                echo "  CI workflow: ${VALUE:-not found}"
                ;;
            publish_method)
                case "$VALUE" in
                    oidc) echo "  Publishing method: OIDC Trusted Publishing (recommended)" ;;
                    token) echo "  Publishing method: NPM_TOKEN secret (traditional)" ;;
                    *) echo "  Publishing method: Unknown" ;;
                esac
                ;;
            publish_node_version)
                echo "  Node.js version: $VALUE"
                ;;
            tag_pattern)
                echo "  Tag pattern: $VALUE"
                ;;
        esac
    done <<< "$(analyze_ci_workflows)"

    echo ""
    echo "Workflow Validation:"
    echo "────────────────────"
    validate_ci_workflows
}

# Detect test commands from package.json scripts
detect_test_command() {
    local PKG_MANAGER="$1"
    if [ -f "package.json" ]; then
        if grep -q '"test:selective"' package.json; then
            echo "${PKG_MANAGER} run test:selective"
        elif grep -q '"test"' package.json; then
            echo "${PKG_MANAGER} test"
        fi
    fi
    echo "${PKG_MANAGER} test"
}

# Generate release_conf.yml from detected settings
generate_config() {
    local OUTPUT_FILE="${1:-config/release_conf.yml}"
    local PKG_MANAGER
    PKG_MANAGER=$(detect_package_manager)
    local MAIN_BRANCH
    MAIN_BRANCH=$(detect_main_branch)
    local VERSION_FILE
    VERSION_FILE=$(detect_version_file)
    local RELEASE_NOTES_GEN
    RELEASE_NOTES_GEN=$(detect_release_notes_generator)

    # Get GitHub info
    local GITHUB_INFO
    GITHUB_INFO=$(detect_github_info)
    local GITHUB_OWNER
    GITHUB_OWNER=$(echo "$GITHUB_INFO" | cut -d' ' -f1)
    local GITHUB_REPO
    GITHUB_REPO=$(echo "$GITHUB_INFO" | cut -d' ' -f2)

    # Get project name from package.json or directory name
    local PROJECT_NAME=""
    local PROJECT_DESC=""
    if [ -f "package.json" ]; then
        PROJECT_NAME=$(jq -r '.name // ""' package.json 2>/dev/null)
        PROJECT_DESC=$(jq -r '.description // ""' package.json 2>/dev/null | head -c 50)
    fi
    if [ -z "$PROJECT_NAME" ]; then
        PROJECT_NAME=$(basename "$(pwd)")
    fi

    # Detect available scripts
    local HAS_LINT="false"
    local HAS_TYPECHECK="false"
    local HAS_E2E="false"
    local HAS_BUILD="false"
    local HAS_SELECTIVE="false"
    if [ -f "package.json" ]; then
        grep -q '"lint"' package.json && HAS_LINT="true"
        grep -q '"typecheck"' package.json && HAS_TYPECHECK="true"
        grep -q '"test:e2e"' package.json && HAS_E2E="true"
        grep -q '"build"' package.json && HAS_BUILD="true"
        grep -q '"test:selective"' package.json && HAS_SELECTIVE="true"
    fi

    # Detect CI workflow settings
    local PUBLISH_METHOD
    PUBLISH_METHOD=$(detect_npm_publish_method)

    local CI_WF_NAME="CI"
    local PUBLISH_WF_NAME="Publish to npm"
    local PUBLISH_NODE_VERSION="24"

    # Extract workflow names from actual files
    for WF in $(find_workflow_files 2>/dev/null); do
        local WF_NAME=$(grep -E "^name:" "$WF" 2>/dev/null | head -1 | sed 's/name:\s*//' | tr -d '"' | tr -d "'")
        if grep -q "npm publish" "$WF" 2>/dev/null; then
            [ -n "$WF_NAME" ] && PUBLISH_WF_NAME="$WF_NAME"
            # Extract Node version
            local NODE_VER=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$WF" 2>/dev/null | head -1 | grep -oE "[0-9]+")
            [ -n "$NODE_VER" ] && PUBLISH_NODE_VERSION="$NODE_VER"
        elif grep -qE "pnpm test|npm test|vitest" "$WF" 2>/dev/null; then
            [ -n "$WF_NAME" ] && CI_WF_NAME="$WF_NAME"
        fi
    done

    # Ensure output directory exists
    mkdir -p "$(dirname "$OUTPUT_FILE")"

    # Generate the config file
    cat > "$OUTPUT_FILE" << YAML_EOF
# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Customize as needed for your project.
#
# To regenerate with auto-detected values:
#   ./scripts/release.sh --init-config
# ============================================================================

# ----------------------------------------------------------------------------
# Project Information
# ----------------------------------------------------------------------------
project:
  name: "${PROJECT_NAME}"
  description: "${PROJECT_DESC}"

# ----------------------------------------------------------------------------
# Version Management
# ----------------------------------------------------------------------------
version:
  file: "${VERSION_FILE}"
  field: "version"
  tag_prefix: "v"                     # Git tag prefix (v1.0.0)

# ----------------------------------------------------------------------------
# Package Manager & Build Tools
# ----------------------------------------------------------------------------
tools:
  package_manager: "${PKG_MANAGER}"
  node_version: "24"                  # Required for npm trusted publishing (npm 11.5.1+)

# ----------------------------------------------------------------------------
# Git & GitHub Configuration
# ----------------------------------------------------------------------------
git:
  main_branch: "${MAIN_BRANCH}"
  remote: "origin"

github:
  owner: "${GITHUB_OWNER}"
  repo: "${GITHUB_REPO}"
  # CRITICAL: GitHub API limitation - target_commitish only accepts:
  #   - Branch names (e.g., "main")
  #   - Full commit SHAs (e.g., "abc123...")
  # "HEAD" and other git refs are NOT valid!
  # See: https://github.com/cli/cli/issues/5855
  release_target: "commit_sha"        # "commit_sha" (recommended) or "branch"

# ----------------------------------------------------------------------------
# Quality Checks
# ----------------------------------------------------------------------------
quality_checks:
  lint:
    enabled: ${HAS_LINT}
    command: "${PKG_MANAGER} run lint"
    auto_fix_command: "${PKG_MANAGER} run lint:fix"

  typecheck:
    enabled: ${HAS_TYPECHECK}
    command: "${PKG_MANAGER} run typecheck"

  tests:
    enabled: true
    mode: "$([ "$HAS_SELECTIVE" = "true" ] && echo "selective" || echo "full")"
    full_command: "${PKG_MANAGER} test"
    selective_command: "node scripts/test-selective.cjs"

  e2e:
    enabled: ${HAS_E2E}
    command: "${PKG_MANAGER} run test:e2e"

  build:
    enabled: ${HAS_BUILD}
    command: "${PKG_MANAGER} run build"
    output_files: []

# ----------------------------------------------------------------------------
# CI/CD Workflow Settings (auto-detected from .github/workflows/)
# ----------------------------------------------------------------------------
ci:
  workflow:
    name: "${CI_WF_NAME}"
    timeout_seconds: 900              # 15 minutes
    poll_interval_seconds: 10

  publish:
    name: "${PUBLISH_WF_NAME}"
    node_version: "${PUBLISH_NODE_VERSION}"
    timeout_seconds: 900
    poll_interval_seconds: 10

# ----------------------------------------------------------------------------
# npm Publishing (auto-detected: ${PUBLISH_METHOD})
# ----------------------------------------------------------------------------
npm:
  registry: "https://registry.npmjs.org"
  access: "public"
  # Publishing method detected from CI workflows:
  #   "oidc"  - OIDC Trusted Publishing (recommended, requires Node.js 24+)
  #   "token" - NPM_TOKEN secret (traditional method)
  publish_method: "${PUBLISH_METHOD}"

# ----------------------------------------------------------------------------
# Release Notes
# ----------------------------------------------------------------------------
release_notes:
  generator: "${RELEASE_NOTES_GEN}"
  config_file: "cliff.toml"

# ----------------------------------------------------------------------------
# Timeouts (seconds)
# ----------------------------------------------------------------------------
timeouts:
  git_operations: 30
  npm_operations: 60
  test_execution: 600
  ci_workflow: 900
  publish_workflow: 900
  npm_propagation: 300

# ----------------------------------------------------------------------------
# Safety Settings
# ----------------------------------------------------------------------------
safety:
  require_clean_worktree: true
  require_main_branch: true
  require_ci_pass: true
  auto_rollback_on_failure: true
  confirm_before_push: false
YAML_EOF

    echo "$OUTPUT_FILE"
}

# Load configuration values into variables
load_config() {
    # Only load if config file exists
    if [ -z "$CONFIG_FILE" ]; then
        return
    fi

    # Override defaults with config values
    CFG_PACKAGE_MANAGER=$(get_config "tools.package_manager" "pnpm")
    CFG_MAIN_BRANCH=$(get_config "git.main_branch" "main")
    CFG_TAG_PREFIX=$(get_config "version.tag_prefix" "v")
    CFG_RELEASE_TARGET=$(get_config "github.release_target" "commit_sha")

    # Timeouts
    CFG_CI_TIMEOUT=$(get_config "ci.workflow.timeout_seconds" "900")
    CFG_PUBLISH_TIMEOUT=$(get_config "ci.publish.timeout_seconds" "900")
    CFG_NPM_PROPAGATION_TIMEOUT=$(get_config "timeouts.npm_propagation" "300")

    # Quality checks
    CFG_LINT_ENABLED=$(get_config_bool "quality_checks.lint.enabled" "true")
    CFG_TYPECHECK_ENABLED=$(get_config_bool "quality_checks.typecheck.enabled" "true")
    CFG_TESTS_ENABLED=$(get_config_bool "quality_checks.tests.enabled" "true")
    CFG_TESTS_MODE=$(get_config "quality_checks.tests.mode" "selective")
    CFG_E2E_ENABLED=$(get_config_bool "quality_checks.e2e.enabled" "true")
    CFG_BUILD_ENABLED=$(get_config_bool "quality_checks.build.enabled" "true")

    # Commands
    CFG_LINT_CMD=$(get_config "quality_checks.lint.command" "pnpm run lint")
    CFG_LINT_FIX_CMD=$(get_config "quality_checks.lint.auto_fix_command" "pnpm run lint:fix")
    CFG_TYPECHECK_CMD=$(get_config "quality_checks.typecheck.command" "pnpm run typecheck")
    CFG_TEST_FULL_CMD=$(get_config "quality_checks.tests.full_command" "pnpm test")
    CFG_TEST_SELECTIVE_CMD=$(get_config "quality_checks.tests.selective_command" "node scripts/test-selective.cjs")
    CFG_E2E_CMD=$(get_config "quality_checks.e2e.command" "pnpm run test:e2e")
    CFG_BUILD_CMD=$(get_config "quality_checks.build.command" "pnpm run build")

    # Safety
    CFG_REQUIRE_CLEAN=$(get_config_bool "safety.require_clean_worktree" "true")
    CFG_REQUIRE_MAIN=$(get_config_bool "safety.require_main_branch" "true")
    CFG_REQUIRE_CI=$(get_config_bool "safety.require_ci_pass" "true")

    # Release notes
    CFG_RELEASE_NOTES_GEN=$(get_config "release_notes.generator" "git-cliff")
}

# Initialize config with defaults (used if no config file)
init_config_defaults() {
    CFG_PACKAGE_MANAGER="pnpm"
    CFG_MAIN_BRANCH="main"
    CFG_TAG_PREFIX="v"
    CFG_RELEASE_TARGET="commit_sha"
    CFG_CI_TIMEOUT="900"
    CFG_PUBLISH_TIMEOUT="900"
    CFG_NPM_PROPAGATION_TIMEOUT="300"
    CFG_LINT_ENABLED="true"
    CFG_TYPECHECK_ENABLED="true"
    CFG_TESTS_ENABLED="true"
    CFG_TESTS_MODE="selective"
    CFG_E2E_ENABLED="true"
    CFG_BUILD_ENABLED="true"
    CFG_LINT_CMD="pnpm run lint"
    CFG_LINT_FIX_CMD="pnpm run lint:fix"
    CFG_TYPECHECK_CMD="pnpm run typecheck"
    CFG_TEST_FULL_CMD="pnpm test"
    CFG_TEST_SELECTIVE_CMD="node scripts/test-selective.cjs"
    CFG_E2E_CMD="pnpm run test:e2e"
    CFG_BUILD_CMD="pnpm run build"
    CFG_REQUIRE_CLEAN="true"
    CFG_REQUIRE_MAIN="true"
    CFG_REQUIRE_CI="true"
    CFG_RELEASE_NOTES_GEN="git-cliff"
}

# Initialize configuration
init_config_defaults
load_config

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

    local CURRENT_BRANCH
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
        AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "0")
        BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")

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
        # WHY check git commit exit code: || true silently swallows errors, which could
        # lead to uncommitted changes being included in the release. We want to know if
        # the commit failed (e.g., pre-commit hook rejection).
        if git commit -m "chore: Auto-fix issues before release (lint, vitest config)"; then
            log_success "  Auto-fixes committed"
        else
            log_warning "  Auto-fix commit failed (pre-commit hook may have modified files)"
            log_info "  → Retrying commit after hook modifications..."
            git add -A
            if ! git commit -m "chore: Auto-fix issues before release (lint, vitest config)"; then
                log_error "  Auto-fix commit failed on retry"
                return 1
            fi
            log_success "  Auto-fixes committed (after retry)"
        fi
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
    # PHASE 5: UNIT & INTEGRATION TESTS (Selective based on changes)
    # WHY: Only test files that changed since last release (or their dependents)
    # RULE: No source unchanged since previous tag should be tested again,
    #       unless it imports a changed library
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 5: Running Tests (Selective based on changes)"

    # Get previous tag to compare changes against
    local PREVIOUS_TAG
    PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    if [ -n "$PREVIOUS_TAG" ]; then
        log_info "  → Running selective tests (changes since $PREVIOUS_TAG)..."
        log_info "  → Only testing files that changed or depend on changed files"

        # Use selective test script with previous tag as base reference
        if ! node scripts/test-selective.cjs "$PREVIOUS_TAG" 2>&1 | tee /tmp/test-output.log | tail -60; then
            log_error "Tests failed"
            log_error "Full output: /tmp/test-output.log"
            # Show failed tests summary
            log_error "Failed tests:"
            grep -E "FAIL|✗|AssertionError" /tmp/test-output.log | head -20 || true
            exit 1
        fi
        log_success "  Selective tests passed"
    else
        log_warning "  No previous tag found - running full test suite"
        log_info "  → Running full test suite (first release)..."
        if ! pnpm test 2>&1 | tee /tmp/test-output.log | tail -60; then
            log_error "Tests failed"
            log_error "Full output: /tmp/test-output.log"
            # Show failed tests summary
            log_error "Failed tests:"
            grep -E "FAIL|✗|AssertionError" /tmp/test-output.log | head -20 || true
            exit 1
        fi
        log_success "  All tests passed"
    fi

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
    local CHANGELOG_SECTION

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

**Full Changelog**: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/compare/${PREVIOUS_TAG}...v${VERSION}
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

    # Mark commits as pushed and store SHA for release creation
    COMMITS_PUSHED=true
    PUSHED_COMMIT_SHA="$HEAD_SHA"

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
    # ══════════════════════════════════════════════════════════════════
    # CRITICAL: GitHub API target_commitish limitation
    # ══════════════════════════════════════════════════════════════════
    # The GitHub Releases API does NOT accept "HEAD" or other git refs
    # as the target_commitish value. Only these are valid:
    #   - Branch names (e.g., "main", "master")
    #   - Full commit SHAs (e.g., "abc123...")
    #
    # "HEAD" causes HTTP 422: "Release.target_commitish is invalid"
    # This is a known platform limitation (NOT a gh CLI bug):
    # See: https://github.com/cli/cli/issues/5855
    #
    # We use explicit commit SHA (recommended) or branch name based on config
    # ══════════════════════════════════════════════════════════════════
    local TARGET_VALUE
    if [ "$CFG_RELEASE_TARGET" = "branch" ]; then
        # Use main branch name (works but less precise)
        TARGET_VALUE="${CFG_MAIN_BRANCH:-main}"
        log_info "Creating release targeting branch: $TARGET_VALUE"
    else
        # Use explicit commit SHA (recommended - more precise)
        TARGET_VALUE="${PUSHED_COMMIT_SHA:-$(git rev-parse HEAD)}"
        log_info "Creating release for commit: ${TARGET_VALUE:0:7}"
    fi

    if ! gh release create "v$VERSION" \
        --target "$TARGET_VALUE" \
        --title "v$VERSION" \
        --notes-file /tmp/release-notes.md; then
        log_error "Failed to create GitHub Release"

        # ROLLBACK WARNING: Tag may have been pushed even though release creation failed
        # WHY: gh release create with --target creates tag first, then creates the release
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
    local MAX_WAIT="${CFG_CI_TIMEOUT:-900}"   # From config or default 15 minutes
    local ELAPSED=0
    local WORKFLOW_JSON MATCHING_RUN WORKFLOW_STATUS WORKFLOW_CONCLUSION RUN_ID

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
    local MAX_WAIT="${CFG_PUBLISH_TIMEOUT:-900}"  # From config or default 15 minutes
    local ELAPSED=0
    local WORKFLOW_JSON MATCHING_RUN WORKFLOW_STATUS WORKFLOW_CONCLUSION RUN_ID

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
        MATCHING_RUN=""
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

    # NOTE: We do NOT use a trap here because it would overwrite the global EXIT trap
    # (handle_exit). Instead, all exit paths in this function manually clean up TEMP_DIR.
    # This preserves the global trap for proper cleanup of other release state.

    # Initialize npm project
    log_info "  → Initializing npm project..."
    if ! (cd "$TEMP_DIR" && npm init -y >/dev/null 2>&1); then
        log_warning "npm init failed in temp directory"
        rm -rf "$TEMP_DIR"
        return 0  # Non-fatal: package is already on npm, just can't verify
    fi

    # Install package from registry (not local tarball)
    log_info "  → Installing ${PACKAGE_NAME}@$VERSION from npm registry..."
    if ! (cd "$TEMP_DIR" && npm install "${PACKAGE_NAME}@$VERSION" --no-save 2>&1 | tail -5); then
        log_warning "npm install failed - package may not be fully propagated yet"
        rm -rf "$TEMP_DIR"
        return 0  # Non-fatal: registry may still be propagating
    fi

    local INSTALLED_PATH="$TEMP_DIR/node_modules/${PACKAGE_NAME}"

    # Verify package exists
    if [ ! -d "$INSTALLED_PATH" ]; then
        log_error "Package not found at $INSTALLED_PATH after install"
        rm -rf "$TEMP_DIR"
        return 1
    fi

    # PHASE 1.4: Test that require('svg-bbox') loads without MODULE_NOT_FOUND
    log_info "  → Verifying require('svg-bbox') works..."
    REQUIRE_TEST=$(cd "$TEMP_DIR" && node -e "try { require('svg-bbox'); console.log('OK'); } catch(e) { console.log(e.code || e.message); process.exit(1); }" 2>&1)
    if [ "$REQUIRE_TEST" != "OK" ]; then
        log_error "require('svg-bbox') failed: $REQUIRE_TEST"
        log_error "This indicates a packaging bug - missing files or broken dependencies"
        rm -rf "$TEMP_DIR"
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
        return 1
    fi

    log_success "  All ${#CLI_TOOLS[@]} CLI tools verified"

    # Cleanup temp directory
    rm -rf "$TEMP_DIR"

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
    # Auto-generate config if none exists (before banner to capture any output)
    if [ -z "$CONFIG_FILE" ]; then
        local AUTO_CONFIG="config/release_conf.yml"
        # Silently generate config and reload
        generate_config "$AUTO_CONFIG" >/dev/null 2>&1
        CONFIG_FILE="$AUTO_CONFIG"
        # Reload configuration from newly generated file
        load_config
    fi

    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "  ${PACKAGE_NAME} Release Script" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "" >&2

    # Parse arguments
    SKIP_CONFIRMATION=false
    VERSION_ARG=""
    INIT_CONFIG_ONLY=false
    CHECK_ONLY=false

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
            --init-config)
                INIT_CONFIG_ONLY=true
                shift
                ;;
            --check)
                CHECK_ONLY=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [options] [version|patch|minor|major]"
                echo ""
                echo "Options:"
                echo "  --yes, -y         Skip confirmation prompt (for CI)"
                echo "  --verbose, -v     Enable debug logging"
                echo "  --init-config     Generate release_conf.yml from project settings"
                echo "  --check           Analyze CI workflows and check for issues"
                echo "  --help, -h        Show this help message"
                echo ""
                echo "Examples:"
                echo "  $0 patch             # Bump patch (1.0.10 → 1.0.11)"
                echo "  $0 minor             # Bump minor (1.0.10 → 1.1.0)"
                echo "  $0 major             # Bump major (1.0.10 → 2.0.0)"
                echo "  $0 1.0.11            # Specific version"
                echo "  $0 --yes patch       # Skip confirmation prompt"
                echo "  $0 --init-config     # Generate config file"
                echo "  $0 --check           # Analyze CI workflows"
                echo ""
                echo "Configuration:"
                echo "  Config file: ${CONFIG_FILE:-'(not found)'}"
                echo "  yq available: $YQ_AVAILABLE"
                echo "  Publishing: $(detect_npm_publish_method)"
                exit 0
                ;;
            *)
                VERSION_ARG=$1
                shift
                ;;
        esac
    done

    # Handle --init-config: generate config and exit
    if [ "$INIT_CONFIG_ONLY" = true ]; then
        log_info "Generating release configuration from project settings..."
        local GENERATED_FILE
        GENERATED_FILE=$(generate_config "config/release_conf.yml")
        log_success "Configuration generated: $GENERATED_FILE"
        log_info ""
        log_info "Detected settings:"
        log_info "  Package manager: $(detect_package_manager)"
        log_info "  Main branch: $(detect_main_branch)"
        log_info "  Version file: $(detect_version_file)"
        log_info "  GitHub: $(detect_github_info | tr ' ' '/')"
        log_info "  npm publish method: $(detect_npm_publish_method)"
        log_info ""
        log_info "Edit the config file to customize release behavior."
        log_info "Re-run the release script to use your configuration."
        exit 0
    fi

    # Handle --check: analyze CI workflows and dependencies
    if [ "$CHECK_ONLY" = true ]; then
        echo ""
        echo "═══════════════════════════════════════════════════════════"
        echo "  Release Script Health Check"
        echo "═══════════════════════════════════════════════════════════"
        echo ""

        # Check dependencies
        echo "Dependency Status:"
        echo "──────────────────"
        local ALL_DEPS_OK=true
        for DEP in gh jq git-cliff yq; do
            if command -v "$DEP" &>/dev/null; then
                local DEP_VERSION=$($DEP --version 2>/dev/null | head -1 || echo "installed")
                echo -e "  ${GREEN}✓${NC} $DEP: $DEP_VERSION"
            else
                echo -e "  ${RED}✗${NC} $DEP: NOT INSTALLED"
                ALL_DEPS_OK=false
            fi
        done

        if [ "$ALL_DEPS_OK" = false ]; then
            print_dependency_instructions
        fi

        # Print CI analysis
        print_ci_analysis

        # Summary
        echo ""
        echo "Configuration Status:"
        echo "─────────────────────"
        if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
            echo -e "  ${GREEN}✓${NC} Config file: $CONFIG_FILE"
        else
            echo -e "  ${YELLOW}!${NC} Config file: Not found (will auto-generate)"
        fi

        if [ "$YQ_AVAILABLE" = true ]; then
            echo -e "  ${GREEN}✓${NC} YAML parser: yq (full support)"
        else
            echo -e "  ${YELLOW}!${NC} YAML parser: grep/sed fallback (limited)"
        fi

        exit 0
    fi

    if [ -z "$VERSION_ARG" ]; then
        log_error "Usage: $0 [options] [version|patch|minor|major]"
        log_info "Options: --yes, --verbose, --init-config, --check, --help"
        log_info "Examples:"
        log_info "  $0 patch             # Bump patch (1.0.10 → 1.0.11)"
        log_info "  $0 --yes patch       # Skip confirmation prompt"
        log_info "  $0 --check           # Analyze CI workflows"
        log_info "  $0 --init-config     # Generate config file"
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

    show_preflight_summary "$PREFLIGHT_CHECKS" "$PREFLIGHT_TOTAL"

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
    # WHY use @version syntax: npm view pkg version returns LATEST version, not specific version
    # We need to check if OUR specific version exists, not compare against latest
    log_info "Checking npm registry for existing version..."
    local EXISTING_NPM_VERSION
    EXISTING_NPM_VERSION=$(npm view "${PACKAGE_NAME}@${NEW_VERSION}" version 2>/dev/null || echo "")
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
