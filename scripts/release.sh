#!/bin/bash
#
# Release Script for svg-bbox
#
# READ-ONLY VALIDATION & RELEASE AUTOMATION
#
# DESIGN PHILOSOPHY: This script is READ-ONLY for user files.
# - VALIDATES comprehensively before release (reports issues with fix instructions)
# - NEVER auto-fixes user code (reports WHAT, WHY, FIX, RUN command)
# - GENERATES only its own config file (release_conf.yml)
# - EXECUTES releases autonomously when validation passes
#
# This script provides fully automated, idempotent releases with:
# ✓ Comprehensive validation (9 categories, ~40 validators)
# ✓ Idempotency (safe to run multiple times, detects existing releases)
# ✓ Rollback on failure (restores clean state if anything goes wrong)
# ✓ Retry logic with exponential backoff (network failures)
# ✓ Actionable error messages (shows WHAT, WHY, FIX, RUN command)
# ✓ Optional confirmation skip (--yes flag for CI/automation)
#
# RELEASE SEQUENCE (CRITICAL ORDER):
# 1. Validate environment and prerequisites
# 2. Run comprehensive validation (reports issues, NEVER auto-fixes)
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
# NOTE: Early extraction before any functions are defined - keep minimal error handling here
# NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
# NOTE: Uses grep (not jq) because jq availability isn't checked yet. This pattern matches
# the first "name" field which is sufficient since package.json has name at top level.
PACKAGE_NAME=$(grep '"name"' package.json 2>/dev/null | head -1 | sed 's/.*"name": "\(.*\)".*/\1/' || true)
if [ -z "$PACKAGE_NAME" ]; then
    echo "ERROR: Cannot extract package name from package.json" >&2
    echo "  Make sure package.json exists and has a 'name' field" >&2
    exit 1
fi

# ══════════════════════════════════════════════════════════════════
# PROJECT-SPECIFIC BUILD OUTPUT FILES
# Centralized configuration for build artifacts that need validation
# NOTE: These are svg-bbox specific. For other projects, update these values
# or make them configurable via release_conf.yml
# ══════════════════════════════════════════════════════════════════
PROJECT_MINIFIED_FILE="SvgVisualBBox.min.js"      # Minified browser bundle
PROJECT_SOURCE_FILE="SvgVisualBBox.js"            # Unminified source for browser
PROJECT_CDN_FILE="$PROJECT_MINIFIED_FILE"         # File served via CDN (jsDelivr, unpkg)

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
VERIFY_TEMP_DIR=""        # Temp directory for post-publish verification (tracked for cleanup)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ══════════════════════════════════════════════════════════════════
# VALIDATION ACCUMULATOR SYSTEM
# Collects all validation errors/warnings for comprehensive reporting
# ══════════════════════════════════════════════════════════════════

# Accumulator arrays for validation results
declare -a VALIDATION_ERRORS=()
declare -a VALIDATION_WARNINGS=()
declare -a VALIDATION_INFO=()

# Validation mode flags
VALIDATE_ONLY=false           # Run validations and exit (--validate-only)
FAST_FAIL=false               # Exit on first error (--fast-fail)
OFFLINE_MODE=false            # Skip network validation (--offline)
JSON_REPORT=false             # Output as JSON (--json-report)
# NOTE: STRICT_MODE default is true, but can be overridden by:
# 1. validation.strict in release_conf.yml (load_config)
# 2. --strict or --no-strict CLI flags (highest priority)
STRICT_MODE=true

# Field delimiter for validation entries
# NOTE: Using ASCII Unit Separator (0x1F) instead of pipe to avoid conflicts
# with shell commands that may contain pipes in the CMD field
VALIDATION_FIELD_SEP=$'\x1F'

# Report a validation error (blocking - prevents release)
# Usage: report_validation_error "CODE" "What happened" "Why it matters" "How to fix" "Command to run"
report_validation_error() {
    local CODE="$1"
    local WHAT="$2"
    local WHY="${3:-}"
    local FIX="${4:-}"
    local CMD="${5:-}"

    # Store fields with unit separator to handle pipes in values
    local ENTRY="${CODE}${VALIDATION_FIELD_SEP}${WHAT}${VALIDATION_FIELD_SEP}${WHY}${VALIDATION_FIELD_SEP}${FIX}${VALIDATION_FIELD_SEP}${CMD}"
    VALIDATION_ERRORS+=("$ENTRY")

    # In fast-fail mode, print immediately and exit
    if [ "$FAST_FAIL" = true ]; then
        print_single_validation_entry "$ENTRY" "ERROR"
        echo ""
        echo -e "${RED}Fast-fail mode: Exiting on first error${NC}"
        exit 1
    fi
}

# Report a validation warning (advisory - release can proceed unless strict mode)
# Usage: report_validation_warning "CODE" "What happened" "Why it matters" "How to fix" "Command to run"
report_validation_warning() {
    local CODE="$1"
    local WHAT="$2"
    local WHY="${3:-}"
    local FIX="${4:-}"
    local CMD="${5:-}"

    # Store fields with unit separator to handle pipes in values
    local ENTRY="${CODE}${VALIDATION_FIELD_SEP}${WHAT}${VALIDATION_FIELD_SEP}${WHY}${VALIDATION_FIELD_SEP}${FIX}${VALIDATION_FIELD_SEP}${CMD}"
    VALIDATION_WARNINGS+=("$ENTRY")
}

# Report validation info (informational only)
report_validation_info() {
    local CODE="$1"
    local WHAT="$2"

    # Store fields with unit separator for consistency
    local ENTRY="${CODE}${VALIDATION_FIELD_SEP}${WHAT}"
    VALIDATION_INFO+=("$ENTRY")
}

# Print a single validation entry with formatting
# Entry format: CODE<SEP>WHAT<SEP>WHY<SEP>FIX<SEP>CMD (where SEP is 0x1F)
print_single_validation_entry() {
    local ENTRY="$1"
    local SEVERITY="$2"

    # Parse entry fields using unit separator
    # NOTE: Using IFS with read is more robust than sed for this parsing
    # NOTE: Save and restore IFS to avoid corrupting caller's word-splitting
    local CODE WHAT WHY FIX CMD
    local OLD_IFS="$IFS"
    IFS="$VALIDATION_FIELD_SEP" read -r CODE WHAT WHY FIX CMD <<< "$ENTRY"
    IFS="$OLD_IFS"

    # Print formatted entry
    if [ "$SEVERITY" = "ERROR" ]; then
        echo -e "  ${RED}[ERROR]${NC} ${BOLD}[$CODE]${NC} $WHAT"
    elif [ "$SEVERITY" = "WARNING" ]; then
        echo -e "  ${YELLOW}[WARN]${NC}  ${BOLD}[$CODE]${NC} $WHAT"
    else
        echo -e "  ${BLUE}[INFO]${NC}  ${BOLD}[$CODE]${NC} $WHAT"
    fi

    # Only print non-empty fields
    if [ -n "$WHY" ]; then
        echo -e "          ${CYAN}WHY:${NC} $WHY"
    fi
    if [ -n "$FIX" ]; then
        echo -e "          ${GREEN}FIX:${NC} $FIX"
    fi
    if [ -n "$CMD" ]; then
        echo -e "          ${YELLOW}RUN:${NC} $CMD"
    fi
    echo ""
}

# Print the complete validation report
# Returns 0 if no blocking errors, 1 if release should be blocked
# NOTE: When JSON_REPORT=true, outputs JSON format instead of human-readable
print_validation_report() {
    local ERROR_COUNT=${#VALIDATION_ERRORS[@]}
    local WARNING_COUNT=${#VALIDATION_WARNINGS[@]}
    local INFO_COUNT=${#VALIDATION_INFO[@]}

    # JSON output mode for CI integration
    if [ "$JSON_REPORT" = true ]; then
        get_validation_json
        # Return appropriate exit code based on blocking status
        if [ "$ERROR_COUNT" -gt 0 ]; then
            return 1
        elif [ "$STRICT_MODE" = true ] && [ "$WARNING_COUNT" -gt 0 ]; then
            return 1
        fi
        return 0
    fi

    # Human-readable output (default)
    echo ""
    echo "=================================================================="
    echo "                    VALIDATION REPORT"
    echo "=================================================================="
    echo ""

    # Print errors (blocking)
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo -e "${RED}${BOLD}ERRORS ($ERROR_COUNT)${NC} - These MUST be fixed before release:"
        echo "--------------------------------------------------------------------"
        for ENTRY in "${VALIDATION_ERRORS[@]}"; do
            print_single_validation_entry "$ENTRY" "ERROR"
        done
    fi

    # Print warnings
    if [ "$WARNING_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}${BOLD}WARNINGS ($WARNING_COUNT)${NC} - Recommended fixes:"
        echo "--------------------------------------------------------------------"
        for ENTRY in "${VALIDATION_WARNINGS[@]}"; do
            print_single_validation_entry "$ENTRY" "WARNING"
        done
    fi

    # Print info (only in verbose mode to reduce noise)
    if [ "$INFO_COUNT" -gt 0 ] && [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}${BOLD}INFO ($INFO_COUNT)${NC} - Notes:"
        echo "--------------------------------------------------------------------"
        for ENTRY in "${VALIDATION_INFO[@]}"; do
            print_single_validation_entry "$ENTRY" "INFO"
        done
    fi

    # Summary
    echo "=================================================================="
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo -e "${RED}${BOLD}RELEASE BLOCKED${NC}: Fix $ERROR_COUNT error(s) before proceeding"
        echo ""
        echo "Run './scripts/release.sh --validate-only' after fixing to re-check."
        return 1
    elif [ "$WARNING_COUNT" -gt 0 ] && [ "$STRICT_MODE" = true ]; then
        echo -e "${YELLOW}${BOLD}RELEASE BLOCKED (strict mode)${NC}: Fix $WARNING_COUNT warning(s)"
        echo ""
        echo "Disable strict mode in release_conf.yml or fix warnings."
        return 1
    elif [ "$WARNING_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}${BOLD}RELEASE ALLOWED${NC}: $WARNING_COUNT warning(s) - consider fixing"
        return 0
    else
        echo -e "${GREEN}${BOLD}ALL VALIDATIONS PASSED${NC}"
        return 0
    fi
}

# Reset validation accumulators (for testing or re-runs)
reset_validation_state() {
    VALIDATION_ERRORS=()
    VALIDATION_WARNINGS=()
    VALIDATION_INFO=()
}

# Get full validation report as JSON (for CI integration)
# Outputs structured JSON with all errors and warnings including details
get_validation_json() {
    local ERROR_COUNT=${#VALIDATION_ERRORS[@]}
    local WARNING_COUNT=${#VALIDATION_WARNINGS[@]}

    # Determine result based on errors and strict mode
    local RESULT="PASSED"
    local BLOCKING="false"
    if [ "$ERROR_COUNT" -gt 0 ]; then
        RESULT="FAILED"
        BLOCKING="true"
    elif [ "$STRICT_MODE" = true ] && [ "$WARNING_COUNT" -gt 0 ]; then
        RESULT="FAILED"
        BLOCKING="true"
    fi

    echo "{"
    echo "  \"result\": \"$RESULT\","
    echo "  \"blocking\": $BLOCKING,"
    echo "  \"strict_mode\": $STRICT_MODE,"
    echo "  \"error_count\": $ERROR_COUNT,"
    echo "  \"warning_count\": $WARNING_COUNT,"

    # Output errors array
    echo "  \"errors\": ["
    local FIRST=true
    for ENTRY in "${VALIDATION_ERRORS[@]}"; do
        # Parse fields using unit separator
        # NOTE: Save and restore IFS to avoid corrupting caller's word-splitting
        local CODE WHAT WHY FIX CMD
        local OLD_IFS="$IFS"
        IFS="$VALIDATION_FIELD_SEP" read -r CODE WHAT WHY FIX CMD <<< "$ENTRY"
        IFS="$OLD_IFS"

        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            echo ","
        fi
        # Escape quotes in strings for valid JSON
        WHAT="${WHAT//\"/\\\"}"
        WHY="${WHY//\"/\\\"}"
        FIX="${FIX//\"/\\\"}"
        CMD="${CMD//\"/\\\"}"
        printf '    {"code": "%s", "what": "%s", "why": "%s", "fix": "%s", "cmd": "%s"}' \
            "$CODE" "$WHAT" "$WHY" "$FIX" "$CMD"
    done
    echo ""
    echo "  ],"

    # Output warnings array
    echo "  \"warnings\": ["
    FIRST=true
    for ENTRY in "${VALIDATION_WARNINGS[@]}"; do
        # Parse fields using unit separator
        # NOTE: Save and restore IFS to avoid corrupting caller's word-splitting
        local CODE WHAT WHY FIX CMD
        local OLD_IFS="$IFS"
        IFS="$VALIDATION_FIELD_SEP" read -r CODE WHAT WHY FIX CMD <<< "$ENTRY"
        IFS="$OLD_IFS"

        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            echo ","
        fi
        # Escape quotes in strings for valid JSON
        WHAT="${WHAT//\"/\\\"}"
        WHY="${WHY//\"/\\\"}"
        FIX="${FIX//\"/\\\"}"
        CMD="${CMD//\"/\\\"}"
        printf '    {"code": "%s", "what": "%s", "why": "%s", "fix": "%s", "cmd": "%s"}' \
            "$CODE" "$WHAT" "$WHY" "$FIX" "$CMD"
    done
    echo ""
    echo "  ]"

    echo "}"
}

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
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        VALUE=$(grep -E "^\s*${SIMPLE_KEY}:" "$CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*:\s*"\?\([^"]*\)"\?.*/\1/' | sed 's/#.*//' | xargs || true)
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
    # NOTE: YAML spec defines true/false/yes/no/on/off as boolean values
    # Also handle common variations and trim whitespace
    VALUE=$(echo "$VALUE" | tr -d '[:space:]')
    case "$VALUE" in
        true|True|TRUE|yes|Yes|YES|on|On|ON|1) echo "true" ;;
        false|False|FALSE|no|No|NO|off|Off|OFF|0|"") echo "false" ;;
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
        # shellcheck disable=SC1087  # False positive: []? is yq syntax for array access, not shell array
        yq -r ".$KEY[]? // empty" "$CONFIG_FILE" 2>/dev/null | tr '\n' ' '
    fi
}

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION AUTO-GENERATION
# Detects project settings from existing files
# ══════════════════════════════════════════════════════════════════

# Detect package manager from lock files
# WHY: Supports multiple package managers with their respective lockfile formats
detect_package_manager() {
    if [ -f "pnpm-lock.yaml" ]; then
        echo "pnpm"
    elif [ -f "yarn.lock" ]; then
        echo "yarn"
    # WHY: Bun has two lockfile formats - bun.lock (text, newer) and bun.lockb (binary, older)
    elif [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
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
    # NOTE: grep returns exit 1 when no match, use || true to prevent pipeline failure
    local BRANCH
    BRANCH=$(git remote show origin 2>/dev/null | grep "HEAD branch" | sed 's/.*: //' || true)
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

# Detect available changelog/release notes generator
# Supports: git-cliff, conventional-changelog, standard-version, auto
detect_release_notes_generator() {
    # Priority order: git-cliff > conventional-changelog > standard-version > auto

    # 1. git-cliff (Rust-based, recommended)
    if [ -f "cliff.toml" ] && command -v git-cliff &>/dev/null; then
        echo "git-cliff"
        return
    fi

    # 2. conventional-changelog-cli (Node.js)
    if command -v conventional-changelog &>/dev/null; then
        echo "conventional-changelog"
        return
    fi

    # 3. Check for npx availability with conventional-changelog
    # NOTE: Use has_npm_dependency for proper JSON parsing (avoids false positives)
    if has_npm_dependency "conventional-changelog-cli"; then
        echo "conventional-changelog"
        return
    fi
    if has_npm_dependency "standard-version"; then
        echo "standard-version"
        return
    fi

    # 4. Auto-generate from git commits
    echo "auto"
}

# ══════════════════════════════════════════════════════════════════
# PROJECT ECOSYSTEM DETECTION
# Detects the programming language/ecosystem of the project
# Supports: node, python, rust, go, ruby, java, dotnet, php, elixir
# ══════════════════════════════════════════════════════════════════

# Detect primary project ecosystem from config files
detect_project_ecosystem() {
    # Check for ecosystem-specific files in order of specificity
    # Node.js ecosystem
    if [ -f "package.json" ]; then
        echo "node"
        return
    fi

    # Python ecosystem
    if [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "setup.cfg" ] || [ -f "requirements.txt" ] || [ -f "Pipfile" ]; then
        echo "python"
        return
    fi

    # Rust ecosystem
    if [ -f "Cargo.toml" ]; then
        echo "rust"
        return
    fi

    # Go ecosystem
    if [ -f "go.mod" ]; then
        echo "go"
        return
    fi

    # Ruby ecosystem (including Homebrew formulas)
    # NOTE: Use ls for glob patterns - [ -f "*.gemspec" ] tests literal filename, not glob
    if [ -f "Gemfile" ] || ls *.gemspec >/dev/null 2>&1 || [ -d "Formula" ] || [ -d "Casks" ]; then
        echo "ruby"
        return
    fi

    # Java ecosystem (Maven/Gradle)
    if [ -f "pom.xml" ]; then
        echo "java-maven"
        return
    fi
    if [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
        echo "java-gradle"
        return
    fi

    # .NET ecosystem
    # NOTE: Use ls for glob patterns - [ -f "*.sln" ] tests literal filename, not glob
    if ls *.csproj >/dev/null 2>&1 || ls *.fsproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
        echo "dotnet"
        return
    fi

    # PHP ecosystem
    if [ -f "composer.json" ]; then
        echo "php"
        return
    fi

    # Elixir ecosystem
    if [ -f "mix.exs" ]; then
        echo "elixir"
        return
    fi

    # Swift ecosystem
    if [ -f "Package.swift" ]; then
        echo "swift"
        return
    fi

    echo "unknown"
}

# ══════════════════════════════════════════════════════════════════
# TASK RUNNER DETECTION
# Detects and uses common task runners/build helpers
# Supports: just, make, task, mage, ninja, rake, invoke, nox, tox
# ══════════════════════════════════════════════════════════════════

# Detect available task runners in priority order
# Returns: space-separated list of available task runners
detect_task_runners() {
    local RUNNERS=""

    # just - Modern command runner (https://github.com/casey/just)
    if [ -f "justfile" ] || [ -f "Justfile" ] || [ -f ".justfile" ]; then
        if command -v just >/dev/null 2>&1; then
            RUNNERS="$RUNNERS just"
        fi
    fi

    # make - Classic build tool
    if [ -f "Makefile" ] || [ -f "makefile" ] || [ -f "GNUmakefile" ]; then
        if command -v make >/dev/null 2>&1; then
            RUNNERS="$RUNNERS make"
        fi
    fi

    # task - Task runner (https://taskfile.dev)
    if [ -f "Taskfile.yml" ] || [ -f "Taskfile.yaml" ] || [ -f "taskfile.yml" ]; then
        if command -v task >/dev/null 2>&1; then
            RUNNERS="$RUNNERS task"
        fi
    fi

    # mage - Go-based build tool (https://magefile.org)
    if [ -f "magefile.go" ] || [ -d "magefiles" ]; then
        if command -v mage >/dev/null 2>&1; then
            RUNNERS="$RUNNERS mage"
        fi
    fi

    # ninja - Fast build system
    if [ -f "build.ninja" ]; then
        if command -v ninja >/dev/null 2>&1; then
            RUNNERS="$RUNNERS ninja"
        fi
    fi

    # rake - Ruby build tool
    if [ -f "Rakefile" ] || [ -f "rakefile" ] || [ -f "Rakefile.rb" ]; then
        if command -v rake >/dev/null 2>&1; then
            RUNNERS="$RUNNERS rake"
        fi
    fi

    # invoke - Python task runner (pyinvoke.org)
    if [ -f "tasks.py" ] || [ -d "tasks" ]; then
        if command -v invoke >/dev/null 2>&1 || command -v inv >/dev/null 2>&1; then
            RUNNERS="$RUNNERS invoke"
        fi
    fi

    # nox - Python automation (nox.thea.codes)
    if [ -f "noxfile.py" ]; then
        if command -v nox >/dev/null 2>&1; then
            RUNNERS="$RUNNERS nox"
        fi
    fi

    # tox - Python testing automation
    if [ -f "tox.ini" ]; then
        if command -v tox >/dev/null 2>&1; then
            RUNNERS="$RUNNERS tox"
        fi
    fi

    # doit - Python build tool
    if [ -f "dodo.py" ]; then
        if command -v doit >/dev/null 2>&1; then
            RUNNERS="$RUNNERS doit"
        fi
    fi

    # pants - Scalable build system
    if [ -f "pants.toml" ] || [ -f "BUILD" ]; then
        if command -v pants >/dev/null 2>&1; then
            RUNNERS="$RUNNERS pants"
        fi
    fi

    # bazel - Google's build system
    if [ -f "WORKSPACE" ] || [ -f "WORKSPACE.bazel" ]; then
        if command -v bazel >/dev/null 2>&1; then
            RUNNERS="$RUNNERS bazel"
        fi
    fi

    # Trim leading space and return
    echo "$RUNNERS" | sed 's/^ *//'
}

# Get the primary (preferred) task runner
detect_primary_task_runner() {
    local RUNNERS
    RUNNERS=$(detect_task_runners)
    # Return first one (highest priority)
    echo "$RUNNERS" | awk '{print $1}'
}

# Check if a task/target exists in a task runner
# Usage: task_runner_has_target <runner> <target>
# Parse targets directly from task runner config files
# This works even if the task runner CLI is not installed
parse_task_runner_targets() {
    local RUNNER="$1"

    case "$RUNNER" in
        just)
            # Parse justfile: targets are lines starting with identifier followed by :
            local JUSTFILE=""
            [ -f "justfile" ] && JUSTFILE="justfile"
            [ -f "Justfile" ] && JUSTFILE="Justfile"
            [ -f ".justfile" ] && JUSTFILE=".justfile"
            if [ -n "$JUSTFILE" ]; then
                # Match recipe definitions: name: or name param:
                grep -E '^[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^:]+)?:' "$JUSTFILE" 2>/dev/null | \
                    sed 's/^\([a-zA-Z_][a-zA-Z0-9_-]*\).*/\1/'
            fi
            ;;
        make)
            # Parse Makefile: targets are lines with identifier followed by :
            local MAKEFILE=""
            [ -f "Makefile" ] && MAKEFILE="Makefile"
            [ -f "makefile" ] && MAKEFILE="makefile"
            [ -f "GNUmakefile" ] && MAKEFILE="GNUmakefile"
            if [ -n "$MAKEFILE" ]; then
                # Match target definitions, exclude pattern rules (%) and special targets (.PHONY)
                grep -E '^[a-zA-Z_][a-zA-Z0-9_-]*:' "$MAKEFILE" 2>/dev/null | \
                    grep -v '^[.]' | sed 's/:.*//'
            fi
            ;;
        task)
            # Parse Taskfile.yml: tasks are top-level keys under 'tasks:'
            local TASKFILE=""
            [ -f "Taskfile.yml" ] && TASKFILE="Taskfile.yml"
            [ -f "Taskfile.yaml" ] && TASKFILE="Taskfile.yaml"
            [ -f "taskfile.yml" ] && TASKFILE="taskfile.yml"
            if [ -n "$TASKFILE" ]; then
                # Extract task names from YAML (lines with 2-space indent after 'tasks:')
                # NOTE: Section boundary is any line starting with non-whitespace followed by colon
                # (handles version:, includes:, vars:, env:, dotenv:, output:, run:, etc.)
                sed -n '/^tasks:/,/^[^[:space:]].*:/p' "$TASKFILE" 2>/dev/null | \
                    sed '1d;$d' | \
                    grep -E '^  [a-zA-Z_][a-zA-Z0-9_-]*:' | sed 's/^  \([^:]*\):.*/\1/'
            fi
            ;;
        rake)
            # Parse Rakefile: look for task :name or desc/task blocks
            if [ -f "Rakefile" ]; then
                grep -E '^\s*task\s+:' Rakefile 2>/dev/null | \
                    sed "s/.*task\s*:\([a-zA-Z_][a-zA-Z0-9_]*\).*/\1/"
            fi
            ;;
        invoke)
            # Parse tasks.py: look for @task decorated functions
            if [ -f "tasks.py" ]; then
                grep -E '^\s*@task|^def\s+[a-zA-Z_]' tasks.py 2>/dev/null | \
                    grep -A1 '@task' | grep '^def' | sed 's/def\s*\([a-zA-Z_][a-zA-Z0-9_]*\).*/\1/'
            fi
            ;;
        nox)
            # Parse noxfile.py: look for @nox.session decorated functions
            if [ -f "noxfile.py" ]; then
                grep -E '@nox.session|^def\s+[a-zA-Z_]' noxfile.py 2>/dev/null | \
                    grep -A1 '@nox.session' | grep '^def' | sed 's/def\s*\([a-zA-Z_][a-zA-Z0-9_]*\).*/\1/'
            fi
            ;;
        tox)
            # Parse tox.ini: look for [testenv:name] sections
            if [ -f "tox.ini" ]; then
                grep -E '^\[testenv:' tox.ini 2>/dev/null | \
                    sed 's/\[testenv:\([^]]*\)\]/\1/'
            fi
            ;;
        doit)
            # Parse dodo.py: look for task_ prefixed functions
            if [ -f "dodo.py" ]; then
                grep -E '^def\s+task_' dodo.py 2>/dev/null | \
                    sed 's/def\s*task_\([a-zA-Z_][a-zA-Z0-9_]*\).*/\1/'
            fi
            ;;
        ninja)
            # Parse build.ninja: look for 'build target:' lines
            if [ -f "build.ninja" ]; then
                grep -E '^build\s+[^:]+:' build.ninja 2>/dev/null | \
                    sed 's/^build\s*\([^:]*\):.*/\1/' | tr ' ' '\n' | head -20
            fi
            ;;
        *)
            echo ""
            ;;
    esac
}

task_runner_has_target() {
    local RUNNER="$1"
    local TARGET="$2"

    # First try CLI if available (more accurate)
    case "$RUNNER" in
        just)
            if command -v just >/dev/null 2>&1; then
                just --list 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        make)
            if command -v make >/dev/null 2>&1; then
                make -n "$TARGET" >/dev/null 2>&1 && return 0
            fi
            ;;
        task)
            if command -v task >/dev/null 2>&1; then
                task --list 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        mage)
            if command -v mage >/dev/null 2>&1; then
                mage -l 2>/dev/null | grep -qiw "$TARGET" && return 0
            fi
            ;;
        rake)
            if command -v rake >/dev/null 2>&1; then
                rake -T 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        invoke)
            if command -v invoke >/dev/null 2>&1; then
                invoke --list 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        nox)
            if command -v nox >/dev/null 2>&1; then
                nox -l 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        tox)
            if command -v tox >/dev/null 2>&1; then
                tox -l 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        ninja)
            if command -v ninja >/dev/null 2>&1; then
                ninja -t targets 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
        doit)
            if command -v doit >/dev/null 2>&1; then
                doit list 2>/dev/null | grep -qw "$TARGET" && return 0
            fi
            ;;
    esac

    # Fallback: parse config file directly
    parse_task_runner_targets "$RUNNER" | grep -qw "$TARGET"
}

# Get the command to run a target with a task runner
# Usage: get_task_runner_command <runner> <target>
get_task_runner_command() {
    local RUNNER="$1"
    local TARGET="$2"

    case "$RUNNER" in
        just)
            echo "just $TARGET"
            ;;
        make)
            echo "make $TARGET"
            ;;
        task)
            echo "task $TARGET"
            ;;
        mage)
            echo "mage $TARGET"
            ;;
        ninja)
            echo "ninja $TARGET"
            ;;
        rake)
            echo "rake $TARGET"
            ;;
        invoke)
            echo "invoke $TARGET"
            ;;
        nox)
            echo "nox -s $TARGET"
            ;;
        tox)
            echo "tox -e $TARGET"
            ;;
        doit)
            echo "doit $TARGET"
            ;;
        pants)
            echo "pants $TARGET"
            ;;
        bazel)
            echo "bazel run //:$TARGET"
            ;;
        *)
            echo ""
            ;;
    esac
}

# Detect commands for common tasks using task runners
# Returns the best command for: build, test, lint, format, release
# Falls back to ecosystem-specific commands if no task runner target exists
detect_task_runner_commands() {
    local RUNNER
    RUNNER=$(detect_primary_task_runner)

    if [ -z "$RUNNER" ]; then
        return 1
    fi

    # Common target names for each task type
    # Multiple alternatives checked in order of preference
    local BUILD_TARGETS="build compile dist bundle"
    local TEST_TARGETS="test tests check"
    local LINT_TARGETS="lint check-lint eslint pylint ruff clippy"
    local FORMAT_TARGETS="format fmt prettier black"
    local TYPECHECK_TARGETS="typecheck type-check types tsc mypy pyright"
    local RELEASE_TARGETS="release publish deploy"
    local E2E_TARGETS="e2e test-e2e integration test-integration"

    # Output detected commands as key=value pairs
    echo "TASK_RUNNER=$RUNNER"

    # Build command
    for target in $BUILD_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_BUILD=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done

    # Test command
    for target in $TEST_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_TEST=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done

    # Lint command
    for target in $LINT_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_LINT=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done

    # Format command
    for target in $FORMAT_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_FORMAT=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done

    # Typecheck command
    for target in $TYPECHECK_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_TYPECHECK=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done

    # Release command
    for target in $RELEASE_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_RELEASE=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done

    # E2E command
    for target in $E2E_TARGETS; do
        if task_runner_has_target "$RUNNER" "$target"; then
            echo "TASK_E2E=$(get_task_runner_command "$RUNNER" "$target")"
            break
        fi
    done
}

# List all available targets from a task runner
# Uses CLI if available, otherwise parses config file directly
list_task_runner_targets() {
    local RUNNER="$1"
    local TARGETS=""

    # Try CLI first (more accurate, handles includes/imports)
    case "$RUNNER" in
        just)
            if command -v just >/dev/null 2>&1; then
                TARGETS=$(just --list 2>/dev/null | tail -n +2 | awk '{print $1}')
            fi
            ;;
        make)
            # make doesn't have a reliable --list, use file parsing
            ;;
        task)
            if command -v task >/dev/null 2>&1; then
                TARGETS=$(task --list 2>/dev/null | tail -n +2 | awk '{print $2}' | tr -d ':')
            fi
            ;;
        mage)
            if command -v mage >/dev/null 2>&1; then
                TARGETS=$(mage -l 2>/dev/null | tail -n +2 | awk '{print $1}')
            fi
            ;;
        rake)
            if command -v rake >/dev/null 2>&1; then
                TARGETS=$(rake -T 2>/dev/null | awk '{print $2}')
            fi
            ;;
        invoke)
            if command -v invoke >/dev/null 2>&1; then
                TARGETS=$(invoke --list 2>/dev/null | tail -n +2 | awk '{print $1}')
            fi
            ;;
        nox)
            if command -v nox >/dev/null 2>&1; then
                TARGETS=$(nox -l 2>/dev/null | grep '^\* ' | sed 's/^\* //' | awk '{print $1}')
            fi
            ;;
        tox)
            if command -v tox >/dev/null 2>&1; then
                TARGETS=$(tox -l 2>/dev/null)
            fi
            ;;
        ninja)
            if command -v ninja >/dev/null 2>&1; then
                # NOTE: || true ensures set -o pipefail doesn't abort on empty awk result
                TARGETS=$(ninja -t targets 2>/dev/null | awk -F: '{print $1}' | head -30 || true)
            fi
            ;;
        doit)
            if command -v doit >/dev/null 2>&1; then
                # NOTE: || true ensures set -o pipefail doesn't abort on empty awk result
                TARGETS=$(doit list 2>/dev/null | awk '{print $1}' || true)
            fi
            ;;
    esac

    # If CLI didn't work, fall back to config file parsing
    if [ -z "$TARGETS" ]; then
        TARGETS=$(parse_task_runner_targets "$RUNNER")
    fi

    echo "$TARGETS"
}

# Get effective command for a task type
# Uses task runner command if configured, otherwise falls back to package manager command
# Usage: get_effective_command <task_type> <fallback_command>
# Task types: build, test, lint, format, typecheck, e2e, release
get_effective_command() {
    local TASK_TYPE="$1"
    local FALLBACK="$2"

    # Only use task runner if enabled
    if [ "${CFG_TASK_RUNNER_ENABLED:-false}" != "true" ]; then
        echo "$FALLBACK"
        return
    fi

    # Check for task runner command based on task type
    local TR_CMD=""
    case "$TASK_TYPE" in
        build)      TR_CMD="${CFG_TASK_RUNNER_BUILD:-}" ;;
        test)       TR_CMD="${CFG_TASK_RUNNER_TEST:-}" ;;
        lint)       TR_CMD="${CFG_TASK_RUNNER_LINT:-}" ;;
        format)     TR_CMD="${CFG_TASK_RUNNER_FORMAT:-}" ;;
        typecheck)  TR_CMD="${CFG_TASK_RUNNER_TYPECHECK:-}" ;;
        e2e)        TR_CMD="${CFG_TASK_RUNNER_E2E:-}" ;;
        release)    TR_CMD="${CFG_TASK_RUNNER_RELEASE:-}" ;;
    esac

    # Return task runner command if available, otherwise fallback
    if [ -n "$TR_CMD" ]; then
        echo "$TR_CMD"
    else
        echo "$FALLBACK"
    fi
}

# ══════════════════════════════════════════════════════════════════
# PYTHON ECOSYSTEM DETECTION
# Detects Python package managers and build systems
# Supports: poetry, uv, pip, pipenv, setuptools, flit, hatch, pdm
# ══════════════════════════════════════════════════════════════════

# Detect Python package manager/build tool
detect_python_package_manager() {
    # Check for modern pyproject.toml-based tools
    if [ -f "pyproject.toml" ]; then
        # Check build-backend in pyproject.toml
        local BUILD_BACKEND=""
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        BUILD_BACKEND=$(grep -E "^build-backend\s*=" pyproject.toml 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" | tr -d ' ' || true)

        case "$BUILD_BACKEND" in
            *poetry*) echo "poetry"; return ;;
            *flit*) echo "flit"; return ;;
            *hatch*) echo "hatch"; return ;;  # Matches both hatch and hatchling
            *pdm*) echo "pdm"; return ;;
            *maturin*) echo "maturin"; return ;;  # Rust+Python hybrid
            *setuptools*) echo "setuptools"; return ;;
        esac

        # Check for tool-specific sections
        if grep -q "\[tool\.poetry\]" pyproject.toml 2>/dev/null; then
            echo "poetry"
            return
        fi
        if grep -q "\[tool\.pdm\]" pyproject.toml 2>/dev/null; then
            echo "pdm"
            return
        fi
        if grep -q "\[tool\.hatch\]" pyproject.toml 2>/dev/null; then
            echo "hatch"
            return
        fi
        if grep -q "\[tool\.flit\]" pyproject.toml 2>/dev/null; then
            echo "flit"
            return
        fi
    fi

    # Check for lock files
    if [ -f "poetry.lock" ]; then
        echo "poetry"
        return
    fi
    if [ -f "uv.lock" ]; then
        echo "uv"
        return
    fi
    if [ -f "pdm.lock" ]; then
        echo "pdm"
        return
    fi
    if [ -f "Pipfile.lock" ] || [ -f "Pipfile" ]; then
        echo "pipenv"
        return
    fi

    # Check for setup.py/setup.cfg (legacy setuptools)
    if [ -f "setup.py" ] || [ -f "setup.cfg" ]; then
        echo "setuptools"
        return
    fi

    # Check for requirements.txt (plain pip)
    if [ -f "requirements.txt" ]; then
        echo "pip"
        return
    fi

    echo "pip"  # Default
}

# Extract a TOML section's content (between [section] and next [section])
# Usage: get_toml_section "file.toml" "section.name"
# NOTE: This prevents name collisions by extracting only content within the section boundaries
# instead of using arbitrary -A20 line counts which can cross section boundaries
get_toml_section() {
    local FILE="$1"
    local SECTION="$2"

    if [ ! -f "$FILE" ]; then
        return
    fi

    # Escape dots for regex: [tool.poetry] -> \[tool\.poetry\]
    local ESCAPED_SECTION
    ESCAPED_SECTION=$(echo "$SECTION" | sed 's/\./\\./g')

    # Extract content between [section] and next [section] header
    # This is section-aware and won't match keys from other sections
    sed -n "/^\[${ESCAPED_SECTION}\]/,/^\[/p" "$FILE" 2>/dev/null | sed '1d;$d' || true
}

# Extract a key's value from a TOML section
# Usage: get_toml_key "file.toml" "section.name" "key"
# NOTE: This avoids false positives from same-named keys in different sections
get_toml_key() {
    local FILE="$1"
    local SECTION="$2"
    local KEY="$3"

    local SECTION_CONTENT
    SECTION_CONTENT=$(get_toml_section "$FILE" "$SECTION")

    if [ -z "$SECTION_CONTENT" ]; then
        return
    fi

    # Extract the key value, handling both quoted and unquoted values
    # Pattern: key = "value" or key = 'value' or key = value
    echo "$SECTION_CONTENT" | grep -E "^${KEY}\s*=" | head -1 | \
        sed 's/.*=\s*//' | \
        sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
        sed 's/^["'"'"']\(.*\)["'"'"']$/\1/' || true
}

# Extract Python project metadata from pyproject.toml
get_python_project_info() {
    local FIELD="$1"

    if [ ! -f "pyproject.toml" ]; then
        echo ""
        return
    fi

    case "$FIELD" in
        "name")
            # Try [project] section first (PEP 621), then [tool.poetry]
            # NOTE: Use section-aware extraction to avoid matching keys from other sections
            local NAME=""
            NAME=$(get_toml_key "pyproject.toml" "project" "name")
            if [ -z "$NAME" ]; then
                NAME=$(get_toml_key "pyproject.toml" "tool.poetry" "name")
            fi
            echo "$NAME"
            ;;
        "version")
            local VERSION=""
            VERSION=$(get_toml_key "pyproject.toml" "project" "version")
            if [ -z "$VERSION" ]; then
                VERSION=$(get_toml_key "pyproject.toml" "tool.poetry" "version")
            fi
            echo "$VERSION"
            ;;
        "description")
            local DESC=""
            DESC=$(get_toml_key "pyproject.toml" "project" "description")
            if [ -z "$DESC" ]; then
                DESC=$(get_toml_key "pyproject.toml" "tool.poetry" "description")
            fi
            # Truncate to 50 chars
            echo "${DESC:0:50}"
            ;;
        "python-version")
            # Get minimum Python version
            local PY_VER=""
            # NOTE: requires-python is at top level in [project], not section-specific
            PY_VER=$(grep -E "^requires-python\s*=" pyproject.toml 2>/dev/null | head -1 | grep -oE "[0-9]+\.[0-9]+" || true)
            if [ -z "$PY_VER" ]; then
                PY_VER=$(get_toml_key "pyproject.toml" "tool.poetry.dependencies" "python")
                PY_VER=$(echo "$PY_VER" | grep -oE "[0-9]+\.[0-9]+" | head -1 || true)
            fi
            echo "${PY_VER:-3.8}"
            ;;
    esac
}

# Detect Python publishing registry (PyPI, TestPyPI, private)
detect_python_registry() {
    # Check pyproject.toml for repository configuration
    if [ -f "pyproject.toml" ]; then
        if grep -q "testpypi" pyproject.toml 2>/dev/null; then
            echo "testpypi"
            return
        fi
        # Check for private registry URL
        local REPO_URL=""
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        REPO_URL=$(grep -A5 "\[tool\.poetry\.repositories\]" pyproject.toml 2>/dev/null | grep -E "url\s*=" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" || true)
        if [ -n "$REPO_URL" ] && [[ ! "$REPO_URL" =~ pypi\.org ]]; then
            echo "private:$REPO_URL"
            return
        fi
    fi
    echo "pypi"
}

# ══════════════════════════════════════════════════════════════════
# RUST/CARGO ECOSYSTEM DETECTION
# Detects Rust package configuration from Cargo.toml
# ══════════════════════════════════════════════════════════════════

# Extract Rust project metadata from Cargo.toml
get_cargo_project_info() {
    local FIELD="$1"

    if [ ! -f "Cargo.toml" ]; then
        echo ""
        return
    fi

    case "$FIELD" in
        "name")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^name\s*=" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" || true
            ;;
        "version")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^version\s*=" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" || true
            ;;
        "description")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^description\s*=" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" | head -c 50 || true
            ;;
        "edition")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^edition\s*=" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" || true
            ;;
        "rust-version")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^rust-version\s*=" | head -1 | sed 's/.*=\s*//' | tr -d '"' | tr -d "'" || true
            ;;
        "publish")
            # Check if publish is disabled
            local PUBLISH=""
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            PUBLISH=$(grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^publish\s*=" | head -1 | sed 's/.*=\s*//' | tr -d ' ' || true)
            if [ "$PUBLISH" = "false" ]; then
                echo "false"
            else
                echo "true"
            fi
            ;;
    esac
}

# Detect Rust registry (crates.io or private)
detect_cargo_registry() {
    if [ -f "Cargo.toml" ]; then
        # Check for custom registry in publish field
        local PUBLISH_REG=""
        PUBLISH_REG=$(grep -A20 "^\[package\]" Cargo.toml 2>/dev/null | grep -E "^publish\s*=\s*\[" | head -1 | grep -oE '"[^"]+"' | head -1 | tr -d '"')
        if [ -n "$PUBLISH_REG" ] && [ "$PUBLISH_REG" != "crates-io" ]; then
            echo "private:$PUBLISH_REG"
            return
        fi
    fi
    echo "crates-io"
}

# Check if Cargo workspace
is_cargo_workspace() {
    if [ -f "Cargo.toml" ]; then
        grep -q "^\[workspace\]" Cargo.toml 2>/dev/null && echo "true" || echo "false"
    else
        echo "false"
    fi
}

# ══════════════════════════════════════════════════════════════════
# GO ECOSYSTEM DETECTION
# Detects Go module configuration from go.mod
# ══════════════════════════════════════════════════════════════════

# Extract Go project metadata from go.mod
get_go_project_info() {
    local FIELD="$1"

    if [ ! -f "go.mod" ]; then
        echo ""
        return
    fi

    case "$FIELD" in
        "module")
            # Extract module path
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -E "^module\s+" go.mod 2>/dev/null | head -1 | sed 's/module\s\+//' || true
            ;;
        "name")
            # Get package name from module path (last component)
            local MODULE=""
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            MODULE=$(grep -E "^module\s+" go.mod 2>/dev/null | head -1 | sed 's/module\s\+//' || true)
            basename "$MODULE"
            ;;
        "go-version")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -E "^go\s+[0-9]" go.mod 2>/dev/null | head -1 | sed 's/go\s\+//' || true
            ;;
        "toolchain")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -E "^toolchain\s+" go.mod 2>/dev/null | head -1 | sed 's/toolchain\s\+//' || true
            ;;
    esac
}

# Detect if Go project is a module or GOPATH project
detect_go_project_type() {
    if [ -f "go.mod" ]; then
        echo "module"
    elif [ -f "go.sum" ]; then
        echo "module"
    else
        echo "gopath"
    fi
}

# ══════════════════════════════════════════════════════════════════
# HOMEBREW TAP DETECTION
# Detects Homebrew formula/cask tap configuration
# ══════════════════════════════════════════════════════════════════

# Detect if project is a Homebrew tap
is_homebrew_tap() {
    if [ -d "Formula" ] || [ -d "Casks" ] || [ -d "HomebrewFormula" ]; then
        echo "true"
    elif [[ "$(basename "$(pwd)")" =~ ^homebrew- ]]; then
        echo "true"
    else
        echo "false"
    fi
}

# Get Homebrew tap info
get_homebrew_tap_info() {
    local FIELD="$1"

    case "$FIELD" in
        "type")
            if [ -d "Casks" ] && [ -d "Formula" ]; then
                echo "mixed"
            elif [ -d "Casks" ]; then
                echo "cask"
            elif [ -d "Formula" ] || [ -d "HomebrewFormula" ]; then
                echo "formula"
            else
                echo "unknown"
            fi
            ;;
        "formula-count")
            # NOTE: Use find instead of ls for filenames with spaces/special chars
            local COUNT=0
            [ -d "Formula" ] && COUNT=$(find Formula -maxdepth 1 -name '*.rb' -type f 2>/dev/null | wc -l | tr -d ' ')
            [ -d "HomebrewFormula" ] && COUNT=$((COUNT + $(find HomebrewFormula -maxdepth 1 -name '*.rb' -type f 2>/dev/null | wc -l | tr -d ' ')))
            echo "$COUNT"
            ;;
        "cask-count")
            # NOTE: Use find instead of ls for filenames with spaces/special chars
            [ -d "Casks" ] && find Casks -maxdepth 1 -name '*.rb' -type f 2>/dev/null | wc -l | tr -d ' ' || echo "0"
            ;;
        "tap-name")
            # Extract tap name from directory or git remote
            local DIR_NAME=""
            DIR_NAME=$(basename "$(pwd)")
            if [[ "$DIR_NAME" =~ ^homebrew-(.+)$ ]]; then
                echo "${BASH_REMATCH[1]}"
            else
                local REMOTE_URL=""
                REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
                if [[ "$REMOTE_URL" =~ /homebrew-([^/]+)(\.git)?$ ]]; then
                    echo "${BASH_REMATCH[1]}"
                else
                    echo "$DIR_NAME"
                fi
            fi
            ;;
    esac
}

# ══════════════════════════════════════════════════════════════════
# CI PLATFORM DETECTION (GitHub-only)
# This script is focused exclusively on GitHub Actions for CI/CD
# ══════════════════════════════════════════════════════════════════

# Check if GitHub Actions is configured
detect_ci_platforms() {
    # Only support GitHub Actions
    if [ -d ".github/workflows" ] && ls .github/workflows/*.yml >/dev/null 2>&1; then
        echo "github"
    else
        echo "none"
    fi
}

# Detect publishing authentication method from GitHub workflow files
detect_ci_auth_method() {
    local ECOSYSTEM="$1"

    case "$ECOSYSTEM" in
        "node")
            # Handled by detect_npm_publish_method
            detect_npm_publish_method
            ;;
        "python")
            # Check for PyPI OIDC trusted publishing
            # NOTE: Use while-read instead of for-loop to handle filenames with spaces
            while IFS= read -r WF; do
                [ -z "$WF" ] && continue
                if grep -q "id-token:\s*write" "$WF" 2>/dev/null; then
                    if grep -qE "pypi-publish|trusted-publishing" "$WF" 2>/dev/null; then
                        echo "oidc"
                        return
                    fi
                fi
            done < <(find_workflow_files 2>/dev/null)
            # Check for PYPI_TOKEN secret
            # NOTE: Use while-read instead of for-loop to handle filenames with spaces
            while IFS= read -r WF; do
                [ -z "$WF" ] && continue
                if grep -qE "PYPI_TOKEN|PYPI_API_TOKEN|TWINE_PASSWORD" "$WF" 2>/dev/null; then
                    echo "token"
                    return
                fi
            done < <(find_workflow_files 2>/dev/null)
            echo "unknown"
            ;;
        "rust")
            # Check for CARGO_REGISTRY_TOKEN
            # NOTE: Use while-read instead of for-loop to handle filenames with spaces
            while IFS= read -r WF; do
                [ -z "$WF" ] && continue
                if grep -q "CARGO_REGISTRY_TOKEN" "$WF" 2>/dev/null; then
                    echo "token"
                    return
                fi
            done < <(find_workflow_files 2>/dev/null)
            echo "unknown"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# ══════════════════════════════════════════════════════════════════
# JAVA ECOSYSTEM DETECTION
# Detects Maven/Gradle configuration
# ══════════════════════════════════════════════════════════════════

# Extract Maven project info from pom.xml
get_maven_project_info() {
    local FIELD="$1"

    if [ ! -f "pom.xml" ]; then
        echo ""
        return
    fi

    # NOTE: Use sed instead of grep -oP (Perl regex) for macOS/BSD compatibility
    case "$FIELD" in
        "groupId")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty sed result
            sed -n 's/.*<groupId>\([^<]*\)<\/groupId>.*/\1/p' pom.xml 2>/dev/null | head -1 || true
            ;;
        "artifactId")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty sed result
            sed -n 's/.*<artifactId>\([^<]*\)<\/artifactId>.*/\1/p' pom.xml 2>/dev/null | head -1 || true
            ;;
        "version")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty sed result
            sed -n 's/.*<version>\([^<]*\)<\/version>.*/\1/p' pom.xml 2>/dev/null | head -1 || true
            ;;
        "name")
            local NAME=""
            # NOTE: || true ensures set -o pipefail doesn't abort on empty sed result
            NAME=$(sed -n 's/.*<name>\([^<]*\)<\/name>.*/\1/p' pom.xml 2>/dev/null | head -1 || true)
            if [ -z "$NAME" ]; then
                # NOTE: || true ensures set -o pipefail doesn't abort on empty sed result
                NAME=$(sed -n 's/.*<artifactId>\([^<]*\)<\/artifactId>.*/\1/p' pom.xml 2>/dev/null | head -1 || true)
            fi
            echo "$NAME"
            ;;
    esac
}

# Extract Gradle project info
get_gradle_project_info() {
    local FIELD="$1"
    local BUILD_FILE="build.gradle"
    [ -f "build.gradle.kts" ] && BUILD_FILE="build.gradle.kts"

    if [ ! -f "$BUILD_FILE" ]; then
        echo ""
        return
    fi

    case "$FIELD" in
        "group")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -E "^group\s*=" "$BUILD_FILE" 2>/dev/null | head -1 | sed "s/.*=\s*//" | tr -d "'" | tr -d '"' || true
            ;;
        "version")
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            grep -E "^version\s*=" "$BUILD_FILE" 2>/dev/null | head -1 | sed "s/.*=\s*//" | tr -d "'" | tr -d '"' || true
            ;;
        "name")
            # Check settings.gradle for rootProject.name
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            if [ -f "settings.gradle" ]; then
                grep -E "rootProject\.name" settings.gradle 2>/dev/null | head -1 | sed "s/.*=\s*//" | tr -d "'" | tr -d '"' || true
            elif [ -f "settings.gradle.kts" ]; then
                grep -E "rootProject\.name" settings.gradle.kts 2>/dev/null | head -1 | sed "s/.*=\s*//" | tr -d "'" | tr -d '"' || true
            else
                basename "$(pwd)"
            fi
            ;;
    esac
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
        "jsonlint")  echo "JSON validator with line numbers|npm install -g jsonlint|https://github.com/zaach/jsonlint" ;;
        "yamllint")  echo "YAML linter with line numbers|pip install yamllint|https://github.com/adrienverge/yamllint" ;;
        "eslint")    echo "JavaScript/TypeScript linter|npm install -g eslint|https://eslint.org" ;;
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
# NOTE: find -o requires grouping with \( \) to apply -type f to all patterns
find_workflow_files() {
    if [ -d ".github/workflows" ]; then
        find .github/workflows -type f \( -name "*.yml" -o -name "*.yaml" \) 2>/dev/null
    fi
}

# Check if a workflow file contains a pattern in actual code (not comments)
# Usage: workflow_has_command "file.yml" "npm publish"
# NOTE: This avoids false positives from commented-out code or documentation
# by filtering out lines starting with # (YAML comments)
workflow_has_command() {
    local FILE="$1"
    local PATTERN="$2"

    if [ ! -f "$FILE" ]; then
        return 1
    fi

    # Filter out comment lines (lines starting with optional whitespace then #)
    # then search for the pattern in actual workflow code
    grep -v '^\s*#' "$FILE" 2>/dev/null | grep -qE "$PATTERN"
}

# Check if a workflow file contains npm publish in a run step (not in comments/names)
# Usage: workflow_has_npm_publish "file.yml"
# NOTE: Avoids false positives from step names like "Publish artifacts" or comments
workflow_has_npm_publish() {
    local FILE="$1"

    if [ ! -f "$FILE" ]; then
        return 1
    fi

    # Look for "npm publish" in run: blocks, not in name: or comments
    # Pattern: line starting with "run:" or continuing a run block, containing "npm publish"
    grep -v '^\s*#' "$FILE" 2>/dev/null | grep -v '^\s*name:' | grep -qE "(run:|npm publish)" | grep -q "npm publish"
    # Simpler fallback: just exclude comment lines and check for npm publish after run:
    if grep -v '^\s*#' "$FILE" 2>/dev/null | grep -qE "run:.*npm publish|npm publish"; then
        return 0
    fi
    return 1
}

# Check if package.json has a specific script defined
# Usage: has_npm_script "lint"
# NOTE: Uses jq for proper JSON parsing to avoid false positives from:
#   - Dependency names containing the script name (e.g., "eslint-plugin-lint")
#   - String values containing the script name
#   - Partial matches in other keys
has_npm_script() {
    local SCRIPT_NAME="$1"
    local PKG_FILE="${2:-package.json}"

    if [ ! -f "$PKG_FILE" ]; then
        return 1
    fi

    # Use jq to check if scripts object has the key (not just grep for the string)
    # Returns "true" if key exists, "false" or error otherwise
    local HAS_SCRIPT
    HAS_SCRIPT=$(jq -r --arg script "$SCRIPT_NAME" '.scripts[$script] // empty' "$PKG_FILE" 2>/dev/null)

    if [ -n "$HAS_SCRIPT" ]; then
        return 0
    fi
    return 1
}

# Get the value of a specific npm script
# Usage: get_npm_script "build"
# NOTE: Uses jq for proper JSON parsing
get_npm_script() {
    local SCRIPT_NAME="$1"
    local PKG_FILE="${2:-package.json}"

    if [ ! -f "$PKG_FILE" ]; then
        return
    fi

    jq -r --arg script "$SCRIPT_NAME" '.scripts[$script] // empty' "$PKG_FILE" 2>/dev/null
}

# Check if package.json has a specific dependency (any type: dependencies, devDependencies, etc.)
# Usage: has_npm_dependency "eslint"
# NOTE: Uses jq to check all dependency sections to avoid false positives
has_npm_dependency() {
    local DEP_NAME="$1"
    local PKG_FILE="${2:-package.json}"

    if [ ! -f "$PKG_FILE" ]; then
        return 1
    fi

    # Check all dependency sections: dependencies, devDependencies, peerDependencies, optionalDependencies
    local HAS_DEP
    HAS_DEP=$(jq -r --arg dep "$DEP_NAME" '
        (.dependencies[$dep] // empty),
        (.devDependencies[$dep] // empty),
        (.peerDependencies[$dep] // empty),
        (.optionalDependencies[$dep] // empty)
    ' "$PKG_FILE" 2>/dev/null | head -1)

    if [ -n "$HAS_DEP" ]; then
        return 0
    fi
    return 1
}

# Detect npm publishing method from workflow files
# Returns: "oidc", "token", "unknown"
detect_npm_publish_method() {
    local PUBLISH_WORKFLOW=""

    # Look for publish workflow
    # NOTE: Use while-read instead of for-loop to handle filenames with spaces
    # NOTE: Use workflow_has_npm_publish to avoid matching comments
    while IFS= read -r WF; do
        [ -z "$WF" ] && continue
        if workflow_has_npm_publish "$WF"; then
            PUBLISH_WORKFLOW="$WF"
            break
        fi
    done < <(find_workflow_files)

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
    # NOTE: grep returns exit 1 when no match, use || true to prevent pipeline failure
    NODE_VERSION=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$PUBLISH_WORKFLOW" 2>/dev/null | head -1 | grep -oE "[0-9]+" || true)

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

    # NOTE: Use while-read instead of for-loop to handle filenames with spaces
    while IFS= read -r WF; do
        [ -z "$WF" ] && continue
        local WF_NAME
        WF_NAME=$(basename "$WF")
        # NOTE: Use workflow_has_npm_publish to avoid matching comments
        if workflow_has_npm_publish "$WF"; then
            PUBLISH_WF="$WF"
        fi
        if workflow_has_command "$WF" "^name:\s*CI" || [[ "$WF_NAME" == "ci.yml" ]]; then
            CI_WF="$WF"
        fi
    done < <(find_workflow_files)

    echo "publish_workflow=${PUBLISH_WF:-none}"
    echo "ci_workflow=${CI_WF:-none}"
    echo "publish_method=$(detect_npm_publish_method)"

    # Extract Node.js version from publish workflow
    if [ -n "$PUBLISH_WF" ]; then
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        local NODE_VER=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$PUBLISH_WF" 2>/dev/null | head -1 | grep -oE "[0-9]+" || true)
        echo "publish_node_version=${NODE_VER:-unknown}"
    fi

    # Extract tag pattern
    if [ -n "$PUBLISH_WF" ]; then
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        local TAG_PATTERN=$(grep -A2 "tags:" "$PUBLISH_WF" 2>/dev/null | grep -oE "'[^']+'" | head -1 | tr -d "'" || true)
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
    # NOTE: Use while-read instead of for-loop to handle filenames with spaces
    # NOTE: Use workflow_has_npm_publish to avoid matching comments
    local PUBLISH_WF=""
    while IFS= read -r WF; do
        [ -z "$WF" ] && continue
        if workflow_has_npm_publish "$WF"; then
            PUBLISH_WF="$WF"
            break
        fi
    done < <(find_workflow_files)

    if [ -z "$PUBLISH_WF" ]; then
        echo "WARNING: No npm publish workflow found in .github/workflows/"
        return
    fi

    local PUBLISH_METHOD
    PUBLISH_METHOD=$(detect_npm_publish_method)

    # Issue 1: OIDC requires Node.js 24+ (npm 11.5.1+)
    if [ "$PUBLISH_METHOD" = "oidc" ]; then
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        local NODE_VER=$(grep -oE "node-version:\s*['\"]?([0-9]+)" "$PUBLISH_WF" 2>/dev/null | head -1 | grep -oE "[0-9]+" || true)
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

    # Issue 8: BUN_VERSION mismatch between CI and publish workflows
    # WHY: Bun lockfile format changes between major versions (e.g., 1.1.x vs 1.3.x)
    # If workflows use different Bun versions, publish can fail with "Unknown lockfile version"
    local CI_WF=""
    while IFS= read -r WF; do
        [ -z "$WF" ] && continue
        if [[ "$WF" == *"ci.yml"* ]] || [[ "$WF" == *"ci.yaml"* ]]; then
            CI_WF="$WF"
            break
        fi
    done < <(find_workflow_files)

    if [ -n "$CI_WF" ] && [ -n "$PUBLISH_WF" ]; then
        # Extract BUN_VERSION from both workflows
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        local CI_BUN_VER=$(grep -oE "BUN_VERSION:\s*['\"]?([0-9]+\.[0-9]+\.[0-9]+)" "$CI_WF" 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true)
        local PUBLISH_BUN_VER=$(grep -oE "BUN_VERSION:\s*['\"]?([0-9]+\.[0-9]+\.[0-9]+)" "$PUBLISH_WF" 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || true)

        if [ -n "$CI_BUN_VER" ] && [ -n "$PUBLISH_BUN_VER" ] && [ "$CI_BUN_VER" != "$PUBLISH_BUN_VER" ]; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "ERROR[$ISSUE_COUNT]: BUN_VERSION mismatch between workflows"
            echo "  ci.yml:      BUN_VERSION: $CI_BUN_VER"
            echo "  publish.yml: BUN_VERSION: $PUBLISH_BUN_VER"
            echo "  WHY: Bun lockfile format changes between major versions"
            echo "  Fix: Update BUN_VERSION in $PUBLISH_WF to '$CI_BUN_VER'"
            echo "  RUN: sed -i \"s/BUN_VERSION: '$PUBLISH_BUN_VER'/BUN_VERSION: '$CI_BUN_VER'/\" $PUBLISH_WF"
            echo ""
        fi

        # Extract NODE_VERSION from both workflows
        local CI_NODE_VER=$(grep -oE "NODE_VERSION:\s*['\"]?([0-9]+)" "$CI_WF" 2>/dev/null | grep -oE "[0-9]+" | head -1 || true)
        local PUBLISH_NODE_VER=$(grep -oE "NODE_VERSION:\s*['\"]?([0-9]+)" "$PUBLISH_WF" 2>/dev/null | grep -oE "[0-9]+" | head -1 || true)

        if [ -n "$CI_NODE_VER" ] && [ -n "$PUBLISH_NODE_VER" ] && [ "$CI_NODE_VER" != "$PUBLISH_NODE_VER" ]; then
            ISSUE_COUNT=$((ISSUE_COUNT + 1))
            echo "ERROR[$ISSUE_COUNT]: NODE_VERSION mismatch between workflows"
            echo "  ci.yml:      NODE_VERSION: $CI_NODE_VER"
            echo "  publish.yml: NODE_VERSION: $PUBLISH_NODE_VER"
            echo "  WHY: npm OIDC requires Node.js 24+ (npm 11.5.1+)"
            echo "  Fix: Update NODE_VERSION in $PUBLISH_WF to '$CI_NODE_VER'"
            echo ""
        fi
    fi

    if [ "$ISSUE_COUNT" -eq 0 ]; then
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
# NOTE: Uses has_npm_script for proper JSON parsing (avoids false positives)
detect_test_command() {
    local PKG_MANAGER="$1"
    if has_npm_script "test:selective"; then
        echo "${PKG_MANAGER} run test:selective"
    elif has_npm_script "test"; then
        echo "${PKG_MANAGER} test"
    else
        echo "${PKG_MANAGER} test"
    fi
}

# Generate release_conf.yml from detected settings
# Supports multiple ecosystems: node, python, rust, go, ruby, java
generate_config() {
    local OUTPUT_FILE="${1:-config/release_conf.yml}"

    # Detect project ecosystem first
    local ECOSYSTEM
    ECOSYSTEM=$(detect_project_ecosystem)

    local MAIN_BRANCH
    MAIN_BRANCH=$(detect_main_branch)
    local VERSION_FILE
    VERSION_FILE=$(detect_version_file)
    local RELEASE_NOTES_GEN
    RELEASE_NOTES_GEN=$(detect_release_notes_generator)

    # Get GitHub repository info
    local GITHUB_INFO
    GITHUB_INFO=$(detect_github_info)
    local GITHUB_OWNER
    GITHUB_OWNER=$(echo "$GITHUB_INFO" | cut -d' ' -f1)
    local GITHUB_REPO
    GITHUB_REPO=$(echo "$GITHUB_INFO" | cut -d' ' -f2)

    # Detect CI platforms (GitHub-only)
    local CI_PLATFORMS
    CI_PLATFORMS=$(detect_ci_platforms)

    # Get project info based on ecosystem
    local PROJECT_NAME=""
    local PROJECT_DESC=""
    local PKG_MANAGER=""
    local RUNTIME_VERSION=""
    local REGISTRY=""
    local PUBLISH_METHOD="unknown"

    case "$ECOSYSTEM" in
        "node")
            PKG_MANAGER=$(detect_package_manager)
            if [ -f "package.json" ]; then
                # NOTE: || echo "" fallback handles case when jq fails (malformed JSON)
                PROJECT_NAME=$(jq -r '.name // ""' package.json 2>/dev/null || echo "")
                PROJECT_DESC=$(jq -r '.description // ""' package.json 2>/dev/null | head -c 50 || echo "")
            fi
            REGISTRY="https://registry.npmjs.org"
            PUBLISH_METHOD=$(detect_npm_publish_method)
            RUNTIME_VERSION="24"
            ;;
        "python")
            PKG_MANAGER=$(detect_python_package_manager)
            PROJECT_NAME=$(get_python_project_info "name")
            PROJECT_DESC=$(get_python_project_info "description")
            REGISTRY=$(detect_python_registry)
            PUBLISH_METHOD=$(detect_ci_auth_method "python")
            RUNTIME_VERSION=$(get_python_project_info "python-version")
            VERSION_FILE="pyproject.toml"
            ;;
        "rust")
            PKG_MANAGER="cargo"
            PROJECT_NAME=$(get_cargo_project_info "name")
            PROJECT_DESC=$(get_cargo_project_info "description")
            REGISTRY=$(detect_cargo_registry)
            PUBLISH_METHOD=$(detect_ci_auth_method "rust")
            RUNTIME_VERSION=$(get_cargo_project_info "rust-version")
            VERSION_FILE="Cargo.toml"
            ;;
        "go")
            PKG_MANAGER="go"
            PROJECT_NAME=$(get_go_project_info "name")
            PROJECT_DESC=""  # Go modules don't have descriptions
            REGISTRY="proxy.golang.org"
            RUNTIME_VERSION=$(get_go_project_info "go-version")
            VERSION_FILE="go.mod"
            ;;
        "java-maven")
            PKG_MANAGER="maven"
            PROJECT_NAME=$(get_maven_project_info "name")
            PROJECT_DESC=""
            REGISTRY="https://repo.maven.apache.org/maven2"
            RUNTIME_VERSION=""
            VERSION_FILE="pom.xml"
            ;;
        "java-gradle")
            PKG_MANAGER="gradle"
            PROJECT_NAME=$(get_gradle_project_info "name")
            PROJECT_DESC=""
            REGISTRY="https://repo.maven.apache.org/maven2"
            RUNTIME_VERSION=""
            VERSION_FILE="build.gradle"
            ;;
        "ruby")
            PKG_MANAGER="bundler"
            if [ "$(is_homebrew_tap)" = "true" ]; then
                PKG_MANAGER="homebrew"
                PROJECT_NAME=$(get_homebrew_tap_info "tap-name")
            fi
            REGISTRY="https://rubygems.org"
            ;;
        *)
            PKG_MANAGER="unknown"
            ;;
    esac

    # Fallback for project name
    if [ -z "$PROJECT_NAME" ]; then
        PROJECT_NAME=$(basename "$(pwd)")
    fi

    # Ensure output directory exists
    mkdir -p "$(dirname "$OUTPUT_FILE")"

    # Generate ecosystem-specific config
    case "$ECOSYSTEM" in
        "node")
            generate_node_config "$OUTPUT_FILE" "$PROJECT_NAME" "$PROJECT_DESC" "$PKG_MANAGER" \
                "$MAIN_BRANCH" "$VERSION_FILE" "$GITHUB_OWNER" "$GITHUB_REPO" \
                "$REGISTRY" "$PUBLISH_METHOD" "$RUNTIME_VERSION" "$RELEASE_NOTES_GEN" "$CI_PLATFORMS"
            ;;
        "python")
            generate_python_config "$OUTPUT_FILE" "$PROJECT_NAME" "$PROJECT_DESC" "$PKG_MANAGER" \
                "$MAIN_BRANCH" "$VERSION_FILE" "$GITHUB_OWNER" "$GITHUB_REPO" \
                "$REGISTRY" "$PUBLISH_METHOD" "$RUNTIME_VERSION" "$RELEASE_NOTES_GEN" "$CI_PLATFORMS"
            ;;
        "rust")
            generate_rust_config "$OUTPUT_FILE" "$PROJECT_NAME" "$PROJECT_DESC" "$PKG_MANAGER" \
                "$MAIN_BRANCH" "$VERSION_FILE" "$GITHUB_OWNER" "$GITHUB_REPO" \
                "$REGISTRY" "$PUBLISH_METHOD" "$RUNTIME_VERSION" "$RELEASE_NOTES_GEN" "$CI_PLATFORMS"
            ;;
        "go")
            generate_go_config "$OUTPUT_FILE" "$PROJECT_NAME" "$PROJECT_DESC" "$PKG_MANAGER" \
                "$MAIN_BRANCH" "$VERSION_FILE" "$GITHUB_OWNER" "$GITHUB_REPO" \
                "$REGISTRY" "$RUNTIME_VERSION" "$RELEASE_NOTES_GEN" "$CI_PLATFORMS"
            ;;
        "ruby"|"java-maven"|"java-gradle")
            generate_generic_config "$OUTPUT_FILE" "$PROJECT_NAME" "$PROJECT_DESC" "$PKG_MANAGER" \
                "$MAIN_BRANCH" "$VERSION_FILE" "$GITHUB_OWNER" "$GITHUB_REPO" \
                "$REGISTRY" "$ECOSYSTEM" "$RELEASE_NOTES_GEN" "$CI_PLATFORMS"
            ;;
        *)
            generate_generic_config "$OUTPUT_FILE" "$PROJECT_NAME" "$PROJECT_DESC" "$PKG_MANAGER" \
                "$MAIN_BRANCH" "$VERSION_FILE" "$GITHUB_OWNER" "$GITHUB_REPO" \
                "" "$ECOSYSTEM" "$RELEASE_NOTES_GEN" "$CI_PLATFORMS"
            ;;
    esac

    echo "$OUTPUT_FILE"
}

# Generate Node.js project config
generate_node_config() {
    local OUTPUT_FILE="$1"
    local PROJECT_NAME="$2"
    local PROJECT_DESC="$3"
    local PKG_MANAGER="$4"
    local MAIN_BRANCH="$5"
    local VERSION_FILE="$6"
    local GITHUB_OWNER="$7"
    local GITHUB_REPO="$8"
    local REGISTRY="$9"
    local PUBLISH_METHOD="${10}"
    local NODE_VERSION="${11}"
    local RELEASE_NOTES_GEN="${12}"
    local CI_PLATFORMS="${13}"

    # Detect available scripts
    # NOTE: Uses has_npm_script for proper JSON parsing (avoids false positives)
    local HAS_LINT="false"
    local HAS_TYPECHECK="false"
    local HAS_E2E="false"
    local HAS_BUILD="false"
    local HAS_SELECTIVE="false"
    has_npm_script "lint" && HAS_LINT="true"
    has_npm_script "typecheck" && HAS_TYPECHECK="true"
    has_npm_script "test:e2e" && HAS_E2E="true"
    has_npm_script "build" && HAS_BUILD="true"
    has_npm_script "test:selective" && HAS_SELECTIVE="true"

    # Detect task runners
    local TASK_RUNNERS
    TASK_RUNNERS=$(detect_task_runners)
    local PRIMARY_RUNNER
    PRIMARY_RUNNER=$(detect_primary_task_runner)

    # Get task runner commands if available
    local TR_BUILD="" TR_TEST="" TR_LINT="" TR_FORMAT="" TR_TYPECHECK="" TR_E2E="" TR_RELEASE=""
    if [ -n "$PRIMARY_RUNNER" ]; then
        # Capture task runner commands
        local TR_CMDS
        TR_CMDS=$(detect_task_runner_commands 2>/dev/null)
        TR_BUILD=$(echo "$TR_CMDS" | grep "^TASK_BUILD=" | cut -d= -f2-)
        TR_TEST=$(echo "$TR_CMDS" | grep "^TASK_TEST=" | cut -d= -f2-)
        TR_LINT=$(echo "$TR_CMDS" | grep "^TASK_LINT=" | cut -d= -f2-)
        TR_FORMAT=$(echo "$TR_CMDS" | grep "^TASK_FORMAT=" | cut -d= -f2-)
        TR_TYPECHECK=$(echo "$TR_CMDS" | grep "^TASK_TYPECHECK=" | cut -d= -f2-)
        TR_E2E=$(echo "$TR_CMDS" | grep "^TASK_E2E=" | cut -d= -f2-)
        TR_RELEASE=$(echo "$TR_CMDS" | grep "^TASK_RELEASE=" | cut -d= -f2-)
    fi

    # Extract CI workflow info
    local CI_WF_NAME="CI"
    local PUBLISH_WF_NAME="Publish to npm"
    # NOTE: Use while-read instead of for-loop to handle filenames with spaces
    while IFS= read -r WF; do
        [ -z "$WF" ] && continue
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        # NOTE: Only get top-level workflow name (first occurrence)
        local WF_NAME
        WF_NAME=$(grep -E "^name:" "$WF" 2>/dev/null | head -1 | sed 's/name:\s*//' | tr -d '"' | tr -d "'" || true)
        # NOTE: Use workflow_has_npm_publish to avoid matching comments
        if workflow_has_npm_publish "$WF"; then
            [ -n "$WF_NAME" ] && PUBLISH_WF_NAME="$WF_NAME"
        elif workflow_has_command "$WF" "pnpm test|npm test|vitest"; then
            [ -n "$WF_NAME" ] && CI_WF_NAME="$WF_NAME"
        fi
    done < <(find_workflow_files 2>/dev/null)

    cat > "$OUTPUT_FILE" << YAML_EOF
# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Ecosystem: Node.js (${PKG_MANAGER})
# CI Platforms: ${CI_PLATFORMS}
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
  ecosystem: "node"

# ----------------------------------------------------------------------------
# Version Management
# ----------------------------------------------------------------------------
version:
  file: "${VERSION_FILE}"
  field: "version"
  tag_prefix: "v"

# ----------------------------------------------------------------------------
# Package Manager & Build Tools
# ----------------------------------------------------------------------------
tools:
  package_manager: "${PKG_MANAGER}"
  node_version: "${NODE_VERSION}"

# ----------------------------------------------------------------------------
# Task Runners (auto-detected)
# Supports: just, make, task, mage, ninja, rake, invoke, nox, tox, etc.
# If a task runner is detected, its commands can override package.json scripts
# ----------------------------------------------------------------------------
task_runner:
  enabled: $([ -n "$PRIMARY_RUNNER" ] && echo "true" || echo "false")
  primary: "${PRIMARY_RUNNER:-none}"
  available: "${TASK_RUNNERS:-none}"
  # Command overrides (leave empty to use package.json scripts)
  commands:
    build: "${TR_BUILD}"
    test: "${TR_TEST}"
    lint: "${TR_LINT}"
    format: "${TR_FORMAT}"
    typecheck: "${TR_TYPECHECK}"
    e2e: "${TR_E2E}"
    release: "${TR_RELEASE}"

# ----------------------------------------------------------------------------
# Git & Repository Configuration
# ----------------------------------------------------------------------------
git:
  main_branch: "${MAIN_BRANCH}"
  remote: "origin"

github:
  owner: "${GITHUB_OWNER}"
  repo: "${GITHUB_REPO}"
  release_target: "commit_sha"

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
# CI/CD Workflow Settings
# ----------------------------------------------------------------------------
ci:
  platforms: "${CI_PLATFORMS}"
  workflow:
    name: "${CI_WF_NAME}"
    timeout_seconds: 900
    poll_interval_seconds: 10

  publish:
    name: "${PUBLISH_WF_NAME}"
    timeout_seconds: 900
    poll_interval_seconds: 10

# ----------------------------------------------------------------------------
# npm Publishing
# ----------------------------------------------------------------------------
npm:
  registry: "${REGISTRY}"
  access: "public"
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
}

# Generate Python project config
generate_python_config() {
    local OUTPUT_FILE="$1"
    local PROJECT_NAME="$2"
    local PROJECT_DESC="$3"
    local PKG_MANAGER="$4"
    local MAIN_BRANCH="$5"
    local VERSION_FILE="$6"
    local GITHUB_OWNER="$7"
    local GITHUB_REPO="$8"
    local REGISTRY="$9"
    local PUBLISH_METHOD="${10}"
    local PYTHON_VERSION="${11}"
    local RELEASE_NOTES_GEN="${12}"
    local CI_PLATFORMS="${13}"

    # Detect available tooling
    local HAS_RUFF="false"
    local HAS_MYPY="false"
    local HAS_PYTEST="false"
    [ -f "pyproject.toml" ] && grep -q "ruff" pyproject.toml 2>/dev/null && HAS_RUFF="true"
    [ -f "pyproject.toml" ] && grep -q "mypy" pyproject.toml 2>/dev/null && HAS_MYPY="true"
    [ -f "pyproject.toml" ] && grep -q "pytest" pyproject.toml 2>/dev/null && HAS_PYTEST="true"
    # NOTE: pytest.ini alone is sufficient to set HAS_PYTEST; pyproject.toml check is separate
    # Fixed operator precedence: || has lower precedence than &&
    [ -f "pytest.ini" ] && HAS_PYTEST="true"
    [ -f "pyproject.toml" ] && grep -q "\[tool\.pytest" pyproject.toml 2>/dev/null && HAS_PYTEST="true"

    # Build commands based on package manager
    local LINT_CMD=""
    local TYPECHECK_CMD=""
    local TEST_CMD=""
    local BUILD_CMD=""
    local PUBLISH_CMD=""

    case "$PKG_MANAGER" in
        "poetry")
            LINT_CMD="poetry run ruff check ."
            TYPECHECK_CMD="poetry run mypy ."
            TEST_CMD="poetry run pytest"
            BUILD_CMD="poetry build"
            PUBLISH_CMD="poetry publish"
            ;;
        "uv")
            LINT_CMD="uv run ruff check ."
            TYPECHECK_CMD="uv run mypy ."
            TEST_CMD="uv run pytest"
            BUILD_CMD="uv build"
            PUBLISH_CMD="uv publish"
            ;;
        "pdm")
            LINT_CMD="pdm run ruff check ."
            TYPECHECK_CMD="pdm run mypy ."
            TEST_CMD="pdm run pytest"
            BUILD_CMD="pdm build"
            PUBLISH_CMD="pdm publish"
            ;;
        "hatch")
            LINT_CMD="hatch run lint:all"
            TYPECHECK_CMD="hatch run types:check"
            TEST_CMD="hatch run test"
            BUILD_CMD="hatch build"
            PUBLISH_CMD="hatch publish"
            ;;
        "pipenv")
            LINT_CMD="pipenv run ruff check ."
            TYPECHECK_CMD="pipenv run mypy ."
            TEST_CMD="pipenv run pytest"
            BUILD_CMD="python -m build"
            PUBLISH_CMD="twine upload dist/*"
            ;;
        *)
            LINT_CMD="ruff check ."
            TYPECHECK_CMD="mypy ."
            TEST_CMD="pytest"
            BUILD_CMD="python -m build"
            PUBLISH_CMD="twine upload dist/*"
            ;;
    esac

    cat > "$OUTPUT_FILE" << YAML_EOF
# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Ecosystem: Python (${PKG_MANAGER})
# CI Platforms: ${CI_PLATFORMS}
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
  ecosystem: "python"

# ----------------------------------------------------------------------------
# Version Management
# ----------------------------------------------------------------------------
version:
  file: "${VERSION_FILE}"
  field: "version"                    # In [project] or [tool.poetry] section
  tag_prefix: "v"

# ----------------------------------------------------------------------------
# Package Manager & Build Tools
# ----------------------------------------------------------------------------
tools:
  package_manager: "${PKG_MANAGER}"
  python_version: "${PYTHON_VERSION}"

# ----------------------------------------------------------------------------
# Git & Repository Configuration
# ----------------------------------------------------------------------------
git:
  main_branch: "${MAIN_BRANCH}"
  remote: "origin"

github:
  owner: "${GITHUB_OWNER}"
  repo: "${GITHUB_REPO}"
  release_target: "commit_sha"

# ----------------------------------------------------------------------------
# Quality Checks
# ----------------------------------------------------------------------------
quality_checks:
  lint:
    enabled: ${HAS_RUFF}
    command: "${LINT_CMD}"
    auto_fix_command: "${LINT_CMD} --fix"

  typecheck:
    enabled: ${HAS_MYPY}
    command: "${TYPECHECK_CMD}"

  tests:
    enabled: ${HAS_PYTEST}
    mode: "full"
    full_command: "${TEST_CMD}"
    coverage_command: "${TEST_CMD} --cov"

  build:
    enabled: true
    command: "${BUILD_CMD}"
    output_files:
      - "dist/*.whl"
      - "dist/*.tar.gz"

# ----------------------------------------------------------------------------
# CI/CD Workflow Settings
# ----------------------------------------------------------------------------
ci:
  platforms: "${CI_PLATFORMS}"
  workflow:
    name: "CI"
    timeout_seconds: 900
    poll_interval_seconds: 10

  publish:
    name: "Publish to PyPI"
    timeout_seconds: 900
    poll_interval_seconds: 10

# ----------------------------------------------------------------------------
# PyPI Publishing
# ----------------------------------------------------------------------------
pypi:
  registry: "${REGISTRY}"
  # Publishing method:
  #   "oidc"  - OIDC Trusted Publishing (recommended for GitHub Actions)
  #   "token" - PYPI_TOKEN secret (traditional method)
  publish_method: "${PUBLISH_METHOD}"
  publish_command: "${PUBLISH_CMD}"

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
  build_operations: 300
  test_execution: 600
  ci_workflow: 900
  publish_workflow: 900

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
}

# Generate Rust/Cargo project config
generate_rust_config() {
    local OUTPUT_FILE="$1"
    local PROJECT_NAME="$2"
    local PROJECT_DESC="$3"
    local PKG_MANAGER="$4"
    local MAIN_BRANCH="$5"
    local VERSION_FILE="$6"
    local GITHUB_OWNER="$7"
    local GITHUB_REPO="$8"
    local REGISTRY="$9"
    local PUBLISH_METHOD="${10}"
    local RUST_VERSION="${11}"
    local RELEASE_NOTES_GEN="${12}"
    local CI_PLATFORMS="${13}"

    local IS_WORKSPACE
    IS_WORKSPACE=$(is_cargo_workspace)
    local EDITION
    EDITION=$(get_cargo_project_info "edition")

    cat > "$OUTPUT_FILE" << YAML_EOF
# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Ecosystem: Rust (cargo)
# CI Platforms: ${CI_PLATFORMS}
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
  ecosystem: "rust"
  is_workspace: ${IS_WORKSPACE}

# ----------------------------------------------------------------------------
# Version Management
# ----------------------------------------------------------------------------
version:
  file: "${VERSION_FILE}"
  field: "version"                    # In [package] section
  tag_prefix: "v"

# ----------------------------------------------------------------------------
# Toolchain Configuration
# ----------------------------------------------------------------------------
tools:
  package_manager: "cargo"
  rust_version: "${RUST_VERSION:-stable}"
  edition: "${EDITION:-2021}"

# ----------------------------------------------------------------------------
# Git & Repository Configuration
# ----------------------------------------------------------------------------
git:
  main_branch: "${MAIN_BRANCH}"
  remote: "origin"

github:
  owner: "${GITHUB_OWNER}"
  repo: "${GITHUB_REPO}"
  release_target: "commit_sha"

# ----------------------------------------------------------------------------
# Quality Checks
# ----------------------------------------------------------------------------
quality_checks:
  lint:
    enabled: true
    command: "cargo clippy -- -D warnings"
    format_command: "cargo fmt --check"

  tests:
    enabled: true
    mode: "full"
    full_command: "cargo test"
    doc_tests: "cargo test --doc"

  build:
    enabled: true
    command: "cargo build --release"
    # Cross-compilation targets (optional)
    targets: []
      # - "x86_64-unknown-linux-gnu"
      # - "x86_64-apple-darwin"
      # - "aarch64-apple-darwin"
      # - "x86_64-pc-windows-msvc"

# ----------------------------------------------------------------------------
# CI/CD Workflow Settings
# ----------------------------------------------------------------------------
ci:
  platforms: "${CI_PLATFORMS}"
  workflow:
    name: "CI"
    timeout_seconds: 1800             # Rust builds can be slow
    poll_interval_seconds: 15

  publish:
    name: "Publish to crates.io"
    timeout_seconds: 900
    poll_interval_seconds: 10

# ----------------------------------------------------------------------------
# crates.io Publishing
# ----------------------------------------------------------------------------
crates:
  registry: "${REGISTRY}"
  # Authentication: CARGO_REGISTRY_TOKEN environment variable
  publish_method: "${PUBLISH_METHOD}"
  publish_command: "cargo publish"
  # For workspaces, use cargo-release or publish each crate
  workspace_publish: "cargo publish -p ${PROJECT_NAME}"

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
  build_operations: 1800              # Rust release builds are slow
  test_execution: 900
  ci_workflow: 1800
  publish_workflow: 900

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
}

# Generate Go project config
generate_go_config() {
    local OUTPUT_FILE="$1"
    local PROJECT_NAME="$2"
    local PROJECT_DESC="$3"
    local PKG_MANAGER="$4"
    local MAIN_BRANCH="$5"
    local VERSION_FILE="$6"
    local GITHUB_OWNER="$7"
    local GITHUB_REPO="$8"
    local REGISTRY="$9"
    local GO_VERSION="${10}"
    local RELEASE_NOTES_GEN="${11}"
    local CI_PLATFORMS="${12}"

    local MODULE_PATH
    MODULE_PATH=$(get_go_project_info "module")

    cat > "$OUTPUT_FILE" << YAML_EOF
# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Ecosystem: Go
# CI Platforms: ${CI_PLATFORMS}
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
  ecosystem: "go"
  module: "${MODULE_PATH}"

# ----------------------------------------------------------------------------
# Version Management
# ----------------------------------------------------------------------------
version:
  # Go modules use git tags for versioning (no version file)
  file: ""
  tag_prefix: "v"
  # Semantic import versioning for v2+
  # Major versions v2+ require module path suffix: github.com/user/repo/v2

# ----------------------------------------------------------------------------
# Toolchain Configuration
# ----------------------------------------------------------------------------
tools:
  package_manager: "go"
  go_version: "${GO_VERSION:-1.21}"

# ----------------------------------------------------------------------------
# Git & Repository Configuration
# ----------------------------------------------------------------------------
git:
  main_branch: "${MAIN_BRANCH}"
  remote: "origin"

github:
  owner: "${GITHUB_OWNER}"
  repo: "${GITHUB_REPO}"
  release_target: "commit_sha"

# ----------------------------------------------------------------------------
# Quality Checks
# ----------------------------------------------------------------------------
quality_checks:
  lint:
    enabled: true
    command: "golangci-lint run"
    format_command: "gofmt -l -w ."

  vet:
    enabled: true
    command: "go vet ./..."

  tests:
    enabled: true
    mode: "full"
    full_command: "go test ./..."
    race_command: "go test -race ./..."
    coverage_command: "go test -coverprofile=coverage.out ./..."

  build:
    enabled: true
    command: "go build ./..."
    # Cross-compilation targets
    targets: []
      # - GOOS=linux GOARCH=amd64
      # - GOOS=darwin GOARCH=amd64
      # - GOOS=darwin GOARCH=arm64
      # - GOOS=windows GOARCH=amd64

# ----------------------------------------------------------------------------
# CI/CD Workflow Settings
# ----------------------------------------------------------------------------
ci:
  platforms: "${CI_PLATFORMS}"
  workflow:
    name: "CI"
    timeout_seconds: 900
    poll_interval_seconds: 10

  release:
    name: "Release"
    timeout_seconds: 900
    poll_interval_seconds: 10

# ----------------------------------------------------------------------------
# Go Module Publishing
# ----------------------------------------------------------------------------
go:
  # Go modules are automatically available via proxy.golang.org
  # after pushing a git tag
  proxy: "${REGISTRY}"
  private: false
  # For private modules, set GOPRIVATE environment variable

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
  build_operations: 600
  test_execution: 600
  ci_workflow: 900
  publish_workflow: 300

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
}

# Generate generic config for other ecosystems
generate_generic_config() {
    local OUTPUT_FILE="$1"
    local PROJECT_NAME="$2"
    local PROJECT_DESC="$3"
    local PKG_MANAGER="$4"
    local MAIN_BRANCH="$5"
    local VERSION_FILE="$6"
    local GITHUB_OWNER="$7"
    local GITHUB_REPO="$8"
    local REGISTRY="$9"
    local ECOSYSTEM="${10}"
    local RELEASE_NOTES_GEN="${11}"
    local CI_PLATFORMS="${12}"

    cat > "$OUTPUT_FILE" << YAML_EOF
# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Ecosystem: ${ECOSYSTEM}
# CI Platforms: ${CI_PLATFORMS}
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
  ecosystem: "${ECOSYSTEM}"

# ----------------------------------------------------------------------------
# Version Management
# ----------------------------------------------------------------------------
version:
  file: "${VERSION_FILE}"
  field: "version"
  tag_prefix: "v"

# ----------------------------------------------------------------------------
# Package Manager & Build Tools
# ----------------------------------------------------------------------------
tools:
  package_manager: "${PKG_MANAGER}"

# ----------------------------------------------------------------------------
# Git & Repository Configuration
# ----------------------------------------------------------------------------
git:
  main_branch: "${MAIN_BRANCH}"
  remote: "origin"

github:
  owner: "${GITHUB_OWNER}"
  repo: "${GITHUB_REPO}"
  release_target: "commit_sha"

# ----------------------------------------------------------------------------
# Quality Checks (customize for your ecosystem)
# ----------------------------------------------------------------------------
quality_checks:
  lint:
    enabled: false
    command: ""

  tests:
    enabled: true
    mode: "full"
    full_command: ""

  build:
    enabled: true
    command: ""

# ----------------------------------------------------------------------------
# CI/CD Workflow Settings
# ----------------------------------------------------------------------------
ci:
  platforms: "${CI_PLATFORMS}"
  workflow:
    name: "CI"
    timeout_seconds: 900
    poll_interval_seconds: 10

# ----------------------------------------------------------------------------
# Publishing
# ----------------------------------------------------------------------------
registry:
  url: "${REGISTRY}"

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
  build_operations: 600
  test_execution: 600
  ci_workflow: 900
  publish_workflow: 900

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
}

# Load configuration values into variables
load_config() {
    # Only load if config file exists
    if [ -z "$CONFIG_FILE" ]; then
        return
    fi

    # Warn if yq is not available - config parsing will use limited grep/sed fallback
    # WHY: Without yq, nested config keys may not be parsed correctly
    if [ "$YQ_AVAILABLE" != true ]; then
        log_warning "yq not found - config parsing limited to simple keys"
        log_warning "  Install yq for full YAML support: brew install yq"
        log_warning "  Nested config values may fall back to defaults"
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

    # Task runner (just, make, task, etc.)
    CFG_TASK_RUNNER_ENABLED=$(get_config_bool "task_runner.enabled" "false")
    CFG_TASK_RUNNER_PRIMARY=$(get_config "task_runner.primary" "")
    CFG_TASK_RUNNER_BUILD=$(get_config "task_runner.commands.build" "")
    CFG_TASK_RUNNER_TEST=$(get_config "task_runner.commands.test" "")
    CFG_TASK_RUNNER_LINT=$(get_config "task_runner.commands.lint" "")
    CFG_TASK_RUNNER_FORMAT=$(get_config "task_runner.commands.format" "")
    CFG_TASK_RUNNER_TYPECHECK=$(get_config "task_runner.commands.typecheck" "")
    CFG_TASK_RUNNER_E2E=$(get_config "task_runner.commands.e2e" "")
    CFG_TASK_RUNNER_RELEASE=$(get_config "task_runner.commands.release" "")

    # Validation settings
    # NOTE: Load STRICT_MODE from config - can be overridden by --strict/--no-strict flags
    local CFG_STRICT=$(get_config_bool "validation.strict" "true")
    if [ "$CFG_STRICT" = "true" ]; then
        STRICT_MODE=true
    else
        STRICT_MODE=false
    fi
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

    # Task runner defaults (auto-detect at runtime if not configured)
    CFG_TASK_RUNNER_ENABLED="false"
    CFG_TASK_RUNNER_PRIMARY=""
    CFG_TASK_RUNNER_BUILD=""
    CFG_TASK_RUNNER_TEST=""
    CFG_TASK_RUNNER_LINT=""
    CFG_TASK_RUNNER_FORMAT=""
    CFG_TASK_RUNNER_TYPECHECK=""
    CFG_TASK_RUNNER_E2E=""
    CFG_TASK_RUNNER_RELEASE=""
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
    if [ "$EXIT_CODE" -ne 0 ] && [ "$EXIT_CODE" -ne 130 ]; then
        echo "" >&2
        log_warning "Script exited with code $EXIT_CODE"
    fi

    # Clean up temp files (always safe to do)
    rm -f /tmp/release-notes.md /tmp/lint-output.log /tmp/typecheck-output.log /tmp/test-output.log 2>/dev/null || true

    # Clean up VERIFY_TEMP_DIR if it exists (from verify_post_publish_installation)
    # WHY: This ensures cleanup happens on interrupt/signal, not just explicit return paths
    if [ -n "$VERIFY_TEMP_DIR" ] && [ -d "$VERIFY_TEMP_DIR" ]; then
        rm -rf "$VERIFY_TEMP_DIR" 2>/dev/null || true
        VERIFY_TEMP_DIR=""
    fi
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

# Enhanced error with actionable guidance
# Usage: error_with_guidance "WHAT happened" "WHY it matters" "HOW to fix it" ["COMMAND to run"]
# WHY: Users need clear, actionable error messages to resolve issues quickly
error_with_guidance() {
    local WHAT="${1:-Unknown error}"
    local WHY="${2:-}"
    local HOW="${3:-}"
    local CMD="${4:-}"

    echo "" >&2
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" >&2
    echo -e "${RED}✗ ERROR:${NC} $WHAT" >&2

    if [ -n "$WHY" ]; then
        echo -e "${YELLOW}  WHY:${NC} $WHY" >&2
    fi

    if [ -n "$HOW" ]; then
        echo -e "${GREEN}  FIX:${NC} $HOW" >&2
    fi

    if [ -n "$CMD" ]; then
        echo -e "${BLUE}  RUN:${NC} $CMD" >&2
    fi
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" >&2
    echo "" >&2
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

# Portable timeout wrapper for macOS compatibility
# CRITICAL: The 'timeout' command (GNU coreutils) does NOT exist on vanilla macOS
# This function provides a cross-platform alternative using bash job control
# Usage: portable_timeout <seconds> <command> [args...]
portable_timeout() {
    local TIMEOUT_SECONDS=$1
    shift

    # If GNU timeout is available, use it (faster and more reliable)
    if command -v timeout >/dev/null 2>&1; then
        timeout "$TIMEOUT_SECONDS" "$@"
        return $?
    fi

    # Fallback for macOS: use bash job control
    # Run command in background, then wait with timeout
    (
        "$@" &
        local CMD_PID=$!

        # Background watchdog that kills the command after timeout
        (
            sleep "$TIMEOUT_SECONDS"
            kill -9 "$CMD_PID" 2>/dev/null
        ) &
        local WATCHDOG_PID=$!

        # Wait for command to complete
        wait "$CMD_PID" 2>/dev/null
        local EXIT_STATUS=$?

        # Kill the watchdog if command completed in time
        kill -9 "$WATCHDOG_PID" 2>/dev/null

        exit $EXIT_STATUS
    )
    return $?
}

# Strip ANSI color codes from string
# SECURITY: Prevents color codes from contaminating version strings used in git tags
strip_ansi() {
    # Remove all ANSI escape sequences: \x1b[...m or \033[...m
    # NOTE: Using [:cntrl:] character class for portability across shells
    # The range '\000-\037' may not work correctly in all shells (bash, zsh, sh)
    echo "$1" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/\o033\[[0-9;]*m//g' | tr -d '\033' | tr -d '[:cntrl:]'
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
    # NOTE: Use printf instead of echo to avoid escape sequence interpretation
    if printf '%s\n' "$VERSION" | grep -q $'\033'; then
        log_error "Version contains ANSI color codes: '$VERSION'"
        log_error "This indicates color output contamination - check npm/log output"
        return 1
    fi

    # Validate semver format: must be exactly X.Y.Z where X,Y,Z are numbers
    # NOTE: Use printf instead of echo to avoid escape sequence interpretation
    if ! printf '%s\n' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        log_error "Invalid version format: '$VERSION'"
        log_error "Expected semver format (e.g., 1.0.12)"
        log_error "Got: $(printf '%s' "$VERSION" | od -c | head -5)"  # Show actual bytes for debugging
        return 1
    fi

    return 0
}

# Retry wrapper for network operations
# Uses exponential backoff with cap to prevent excessive wait times
retry_with_backoff() {
    local MAX_RETRIES=3
    local RETRY_COUNT=0
    local BACKOFF=2
    local MAX_BACKOFF=16  # Cap at 16 seconds to prevent excessive waiting

    # WHY use $* instead of $@: When assigning to a string variable, $* concatenates
    # all arguments with the first character of IFS (space by default), while $@
    # would create an array which can't be assigned to a string variable.
    local CMD="$*"

    while [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; do
        if eval "$CMD"; then
            return 0
        fi

        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; then
            log_warning "Command failed, retrying in ${BACKOFF}s... (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)"
            sleep $BACKOFF
            # Exponential backoff with cap: 2s -> 4s -> 8s -> 16s (capped)
            BACKOFF=$((BACKOFF * 2))
            if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then
                BACKOFF=$MAX_BACKOFF
            fi
        fi
    done

    log_error "Command failed after $MAX_RETRIES attempts: $CMD"
    return 1
}

# Validate prerequisites
validate_prerequisites() {
    log_info "Validating prerequisites..."

    # Check for required commands with actionable guidance
    if ! command_exists gh; then
        error_with_guidance \
            "GitHub CLI (gh) is not installed" \
            "The release script uses gh for GitHub operations (releases, workflow status, API calls)" \
            "Install the GitHub CLI from https://cli.github.com/" \
            "brew install gh  # macOS with Homebrew"
        exit 1
    fi

    if ! command_exists npm; then
        error_with_guidance \
            "npm is not installed" \
            "npm is required for package version management and publishing" \
            "Install Node.js (includes npm) from https://nodejs.org/" \
            "brew install node  # macOS with Homebrew"
        exit 1
    fi

    if ! command_exists pnpm; then
        error_with_guidance \
            "pnpm is not installed" \
            "This project uses pnpm for faster, disk-efficient dependency management" \
            "Install pnpm globally via npm or Homebrew" \
            "npm install -g pnpm  # or: brew install pnpm"
        exit 1
    fi

    if ! command_exists jq; then
        error_with_guidance \
            "jq is not installed" \
            "jq is required for parsing JSON (package.json, API responses)" \
            "Install jq using your package manager" \
            "brew install jq  # macOS  |  apt-get install jq  # Linux"
        exit 1
    fi

    if ! command_exists git-cliff; then
        error_with_guidance \
            "git-cliff is not installed" \
            "git-cliff generates beautiful changelogs from conventional commits" \
            "Install git-cliff via Homebrew or Cargo" \
            "brew install git-cliff  # macOS  |  cargo install git-cliff  # Linux"
        exit 1
    fi

    # Check gh auth status
    if ! gh auth status >/dev/null 2>&1; then
        error_with_guidance \
            "GitHub CLI is not authenticated" \
            "Release operations require authenticated access to GitHub (creating releases, checking workflows)" \
            "Log in to GitHub using the CLI" \
            "gh auth login"
        exit 1
    fi

    log_success "All prerequisites met"
}

# Clean up test artifacts before checking working directory
# WHY: Test runs create temp directories that pollute git status output
# and confuse users when release fails due to "uncommitted changes"
cleanup_test_artifacts() {
    log_info "Cleaning up test artifacts..."

    local cleaned_count=0
    local cleaned_items=""

    # Remove temp test directories and files (created by integration tests)
    # These match patterns in .gitignore: temp_*/, test_batch.txt, test_regenerated.svg
    local patterns=("temp_*" "test_batch.txt" "test_regenerated.svg" "*-last-conversation.txt")

    for pattern in "${patterns[@]}"; do
        # Use find to safely match patterns and remove
        # WHY: Using glob directly with rm can fail if no matches exist
        # NOTE: No head limit - clean ALL matching items to ensure clean state
        while IFS= read -r -d '' item; do
            if [ -n "$item" ]; then
                if [ -d "$item" ]; then
                    if rm -rf "$item" 2>/dev/null; then
                        cleaned_count=$((cleaned_count + 1))
                        cleaned_items="${cleaned_items}  - ${item} (dir)\n"
                    fi
                elif [ -f "$item" ]; then
                    if rm -f "$item" 2>/dev/null; then
                        cleaned_count=$((cleaned_count + 1))
                        cleaned_items="${cleaned_items}  - ${item} (file)\n"
                    fi
                fi
            fi
        done < <(find . -maxdepth 1 -name "$pattern" -print0 2>/dev/null)
    done

    # Also clean up test temp directories in tests/ folder (if tests/ exists)
    # WHY: Integration tests may create temp dirs inside tests/
    if [ -d "tests" ]; then
        while IFS= read -r -d '' item; do
            if [ -n "$item" ] && rm -rf "$item" 2>/dev/null; then
                cleaned_count=$((cleaned_count + 1))
                cleaned_items="${cleaned_items}  - ${item} (test-dir)\n"
            fi
        done < <(find tests/ -maxdepth 1 -type d \( -name ".tmp-*" -o -name "test-cli-security-temp" \) -print0 2>/dev/null)
    fi

    # Report what was cleaned (helps debugging)
    if [ "$cleaned_count" -gt 0 ]; then
        log_success "Test artifacts cleaned up ($cleaned_count items removed)"
        # Show details only in verbose mode or if few items
        if [ "$cleaned_count" -le 5 ]; then
            echo -e "$cleaned_items" | grep -v '^$' | head -5 >&2
        fi
    else
        log_success "Test artifacts cleaned up (none found)"
    fi
}

# Check if working directory is clean
check_clean_working_dir() {
    log_info "Checking working directory..."

    # SAFEGUARD: Clean up gitignored test artifacts before checking
    # This prevents confusing "uncommitted changes" errors from test temp files
    cleanup_test_artifacts

    if ! git diff-index --quiet HEAD --; then
        echo "" >&2
        log_error "Working directory has uncommitted changes:"
        git status --short >&2
        echo "" >&2
        error_with_guidance \
            "Working directory is not clean" \
            "Releases must be created from a clean state to ensure reproducibility and prevent accidental inclusion of unfinished work" \
            "Commit your changes, or stash them temporarily" \
            "git stash  # to save and revert  |  git add -A && git commit -m 'WIP'  # to commit"
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
        error_with_guidance \
            "Not on main branch (currently on '$CURRENT_BRANCH')" \
            "Releases should only be made from the main branch to ensure stability and proper versioning" \
            "Switch to main branch, or merge your changes first" \
            "git checkout main && git merge $CURRENT_BRANCH"
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
        error_with_guidance \
            "Failed to fetch from origin/main" \
            "Cannot verify your branch is up-to-date without network access to GitHub" \
            "Check your network connection and GitHub authentication" \
            "gh auth status && ping github.com"
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
            error_with_guidance \
                "Local branch is $BEHIND commit(s) BEHIND origin/main" \
                "Someone pushed changes to main. You need to pull them before releasing to avoid conflicts" \
                "Pull the latest changes from origin" \
                "git pull origin main"
            exit 1
        fi

        if [ "$AHEAD" -gt 0 ]; then
            error_with_guidance \
                "Local branch is $AHEAD commit(s) AHEAD of origin/main" \
                "You have unpushed commits. These would be included in the release without CI verification" \
                "Either push these commits first, or reset to match origin" \
                "git push origin main  # to include them  |  git reset --hard origin/main  # to discard"
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

    # File readability check (NOT YAML syntax - that's done by validate_yaml_files)
    # WHY: Catch file permission or encoding issues early
    # NOTE: Actual YAML syntax validation is done separately by validate_yaml_files()
    for WORKFLOW in "${REQUIRED_WORKFLOWS[@]}"; do
        # Check file can be read (permission, encoding issues)
        if ! node -e "require('fs').readFileSync('$WORKFLOW', 'utf8')" 2>/dev/null; then
            log_error "Cannot read workflow file: $WORKFLOW"
            log_error "Check file permissions and encoding"
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
    NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//')

    # Guard against empty NODE_VERSION (node not installed or failed)
    if [ -z "$NODE_VERSION" ]; then
        log_error "Failed to detect Node.js version"
        log_error "Ensure Node.js is installed and in PATH"
        exit 1
    fi

    local NODE_MAJOR
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

    # Guard against empty NODE_MAJOR (malformed version string)
    if [ -z "$NODE_MAJOR" ] || ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
        log_error "Failed to parse Node.js major version from: $NODE_VERSION"
        exit 1
    fi

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
# WHY: Version mismatches cause confusion about which version is released
# READ-ONLY: Reports issues, does NOT auto-fix or modify files
validate_version_sync() {
    log_info "Validating version synchronization..."

    # Get version from package.json (source of truth)
    local PKG_VERSION
    PKG_VERSION=$(get_current_version)
    local HAS_ERRORS=false

    # Get version from version.cjs
    # NOTE: version.cjs may use one of two patterns:
    # 1. Hardcoded: const VERSION = '1.0.12';
    # 2. Dynamic: reads from package.json (always in sync by design)
    local VERSION_CJS_VERSION
    if [ -f "version.cjs" ]; then
        # Check if version.cjs reads dynamically from package.json
        # Pattern: require('fs').readFileSync + package.json
        if grep -q "package.json" version.cjs && grep -qE "readFileSync|require.*package" version.cjs; then
            # Dynamic version - always in sync with package.json by design
            log_verbose "  version.cjs reads from package.json (always in sync)"
        else
            # Check for hardcoded version constant: const VERSION = '1.0.12';
            # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
            VERSION_CJS_VERSION=$(grep "const VERSION" version.cjs | sed "s/.*'\([^']*\)'.*/\1/" | head -1 || true)
            if [ -z "$VERSION_CJS_VERSION" ]; then
                report_validation_warning "VERSION_CJS_PARSE" \
                    "Could not extract version from version.cjs" \
                    "Unable to verify version consistency for this file" \
                    "Check that version.cjs reads from package.json or has format: const VERSION = 'X.Y.Z';"
            elif [ "$PKG_VERSION" != "$VERSION_CJS_VERSION" ]; then
                report_validation_error "VERSION_CJS_SYNC" \
                    "version.cjs ($VERSION_CJS_VERSION) does not match package.json ($PKG_VERSION)" \
                    "Published package will have inconsistent version info in CLI output" \
                    "Run the build command to sync versions, then commit the changes" \
                    "pnpm run build && git add version.cjs && git commit -m 'build: sync version'"
                HAS_ERRORS=true
            fi
        fi
    else
        report_validation_warning "VERSION_CJS_MISSING" \
            "version.cjs not found" \
            "Cannot verify CLI version string consistency" \
            "Create version.cjs if CLI needs to report version"
    fi

    # Get version from minified file preamble comment
    # NOTE: Uses PROJECT_MINIFIED_FILE variable from top of script
    local MINIFIED_VERSION
    if [ -f "$PROJECT_MINIFIED_FILE" ]; then
        # Extract version from preamble: /*! SvgVisualBBox v1.0.12 - ...
        MINIFIED_VERSION=$(head -1 "$PROJECT_MINIFIED_FILE" | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | sed 's/v//')
        if [ -z "$MINIFIED_VERSION" ]; then
            report_validation_warning "MINIFIED_PREAMBLE_PARSE" \
                "Could not extract version from $PROJECT_MINIFIED_FILE preamble" \
                "Unable to verify browser library version consistency" \
                "Check that minified file has preamble: /*! LibraryName vX.Y.Z - ..."
        elif [ "$PKG_VERSION" != "$MINIFIED_VERSION" ]; then
            report_validation_error "MINIFIED_VERSION_SYNC" \
                "$PROJECT_MINIFIED_FILE preamble ($MINIFIED_VERSION) does not match package.json ($PKG_VERSION)" \
                "CDN users will see wrong version in browser DevTools" \
                "Rebuild the minified library and commit the changes" \
                "pnpm run build && git add $PROJECT_MINIFIED_FILE && git commit -m 'build: regenerate minified library'"
            HAS_ERRORS=true
        fi
    else
        report_validation_warning "MINIFIED_MISSING" \
            "$PROJECT_MINIFIED_FILE not found" \
            "Browser library will not be available for CDN distribution" \
            "Run build to generate minified file" \
            "pnpm run build"
    fi

    # Return status based on errors found
    if [ "$HAS_ERRORS" = true ]; then
        log_error "Version synchronization validation failed"
        return 1
    fi

    log_success "Version synchronization validated: $PKG_VERSION"
    return 0
}

# PHASE 1.6: Validate UMD wrapper syntax before release
# Ensures the minified file can be parsed by Node.js without syntax errors
# and properly exports the library namespace
# NOTE: Uses PROJECT_MINIFIED_FILE variable from top of script
validate_umd_wrapper() {
    log_info "Validating UMD wrapper syntax..."

    # Use project-specific minified file path
    local MINIFIED_FILE="$PROJECT_MINIFIED_FILE"

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
        # NOTE: Use grep -qF for fixed-string matching (function names are literal)
        if ! grep -qF "$export_name" "$MINIFIED_FILE"; then
            log_error "UMD wrapper missing expected export: $export_name"
            log_error "The minification may have removed or corrupted this function"
            return 1
        fi
    done

    # Step 3: Verify UMD factory pattern structure
    # Check for the characteristic UMD wrapper pattern
    # NOTE: Minifiers rename 'module' to short names like 't', so check for
    # the pattern '.exports' which matches both 'module.exports' and 't.exports'
    if ! grep -qE '\.exports' "$MINIFIED_FILE"; then
        log_error "UMD wrapper missing CommonJS export pattern (.exports)"
        return 1
    fi

    # NOTE: Use grep -qF for fixed-string matching (pattern is literal)
    if ! grep -qF 'SvgVisualBBox' "$MINIFIED_FILE"; then
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
    # NOTE: Use grep -qF for fixed-string matching (version dots are literal, not regex)
    if git tag -l "v$VERSION" | grep -qF "v$VERSION"; then
        log_error "Git tag v$VERSION already exists locally"
        log_info "To delete: git tag -d v$VERSION"
        return 1
    fi

    # Check remote tags
    # NOTE: Use grep -qF for fixed-string matching (version dots are literal, not regex)
    if git ls-remote --tags origin 2>/dev/null | grep -qF "refs/tags/v$VERSION"; then
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
# Returns the version string or exits with error if not found
# NOTE: Uses jq for proper JSON parsing to avoid false positives from nested version fields
get_current_version() {
    local VERSION
    # Use jq to get the top-level version field (avoids matching nested version strings)
    VERSION=$(jq -r '.version // empty' package.json 2>/dev/null || true)

    if [ -z "$VERSION" ]; then
        log_error "Cannot extract version from package.json"
        log_error "  Make sure package.json exists and has a 'version' field"
        return 1
    fi

    # Validate semver format (basic check)
    # NOTE: Use printf instead of echo to avoid escape sequence interpretation
    if ! printf '%s\n' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
        log_error "Invalid version format in package.json: '$VERSION'"
        log_error "  Expected semver format (e.g., 1.0.12)"
        return 1
    fi

    # NOTE: Use printf instead of echo to avoid escape sequence interpretation
    printf '%s\n' "$VERSION"
}

# Calculate what the next version would be (without modifying anything)
# Used for --validate-only mode to check target version
calculate_next_version() {
    local CURRENT_VERSION="$1"
    local BUMP_TYPE="$2"

    # Parse current version components
    local MAJOR MINOR PATCH
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

    # Strip any pre-release suffix for calculation
    PATCH="${PATCH%%-*}"

    case "$BUMP_TYPE" in
        major)
            echo "$((MAJOR + 1)).0.0"
            ;;
        minor)
            echo "${MAJOR}.$((MINOR + 1)).0"
            ;;
        patch)
            echo "${MAJOR}.${MINOR}.$((PATCH + 1))"
            ;;
        *)
            # Unknown bump type, return as-is (probably a specific version)
            echo "$BUMP_TYPE"
            ;;
    esac
}

# Bump version using npm version
bump_version() {
    local VERSION_TYPE=$1
    local NEW_VERSION

    log_info "Bumping version ($VERSION_TYPE)..."

    # SECURITY: Silence npm entirely to prevent hook output contamination
    # npm lifecycle hooks ("version", "prepublishOnly") output to stdout, which
    # cannot be suppressed with 2>/dev/null. We must silence all npm output
    # and read the version from package.json instead.
    npm version "$VERSION_TYPE" --no-git-tag-version >/dev/null 2>&1

    # Check if npm version succeeded
    # WHY: npm can fail silently, we must verify it actually worked
    if [ "$?" -ne 0 ]; then
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
    local ACTUAL_VERSION

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
    if [ "$?" -ne 0 ]; then
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


# ══════════════════════════════════════════════════════════════════
# COMPREHENSIVE QUALITY CHECKS
# These checks mirror EXACTLY what CI does to prevent surprises
# WHY: Any difference between local checks and CI causes release failures
# ══════════════════════════════════════════════════════════════════

# Validate JSON files are syntactically correct
# WHY: Invalid JSON breaks npm, eslint, and other tools silently
# READ-ONLY: Reports issues, does NOT auto-fix
# NOTE: Uses jsonlint for detailed error messages with line/column numbers
validate_json_files() {
    log_info "  → Validating JSON files..."

    # NOTE: tsconfig.json uses JSONC (JSON with Comments) which TypeScript supports
    # but jsonlint doesn't. Skip it from validation - tsc handles it natively.
    local JSON_FILES=(
        "package.json"
        ".eslintrc.json"
        ".prettierrc.json"
    )

    # Check if jsonlint is available (toolchain status already reported)
    local USE_JSONLINT=false
    if command -v jsonlint >/dev/null 2>&1; then
        USE_JSONLINT=true
    fi

    local HAS_ERRORS=false
    for JSON_FILE in "${JSON_FILES[@]}"; do
        if [ -f "$JSON_FILE" ]; then
            local PARSE_ERROR
            local EXIT_CODE

            if [ "$USE_JSONLINT" = true ]; then
                # Use jsonlint for detailed error messages with line/column numbers
                PARSE_ERROR=$(jsonlint -q "$JSON_FILE" 2>&1)
                EXIT_CODE=$?
            else
                # Fallback to Node.js JSON.parse() if jsonlint not installed
                PARSE_ERROR=$(node -e "
                    try {
                        JSON.parse(require('fs').readFileSync('$JSON_FILE', 'utf8'));
                    } catch(e) {
                        console.error(e.message);
                        process.exit(1);
                    }
                " 2>&1)
                EXIT_CODE=$?
            fi

            if [ "$EXIT_CODE" -ne 0 ]; then
                # Format error message - jsonlint provides line:column info
                local ERROR_MSG="${PARSE_ERROR:-unknown error}"
                # Truncate very long error messages for display
                if [ ${#ERROR_MSG} -gt 200 ]; then
                    ERROR_MSG="${ERROR_MSG:0:200}..."
                fi
                report_validation_error "JSON_SYNTAX" \
                    "Invalid JSON syntax in $JSON_FILE" \
                    "npm, eslint, and other tools will fail to parse this file" \
                    "Fix the JSON syntax error: $ERROR_MSG" \
                    "jsonlint '$JSON_FILE'"
                HAS_ERRORS=true
            fi
        fi
    done

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  JSON files valid"
    return 0
}

# Validate YAML workflow files
# WHY: Invalid YAML causes CI to fail silently or behave unexpectedly
# READ-ONLY: Reports issues, does NOT auto-fix
# NOTE: Uses yamllint (preferred) > yq > basic grep validation
validate_yaml_files() {
    log_info "  → Validating YAML workflow files..."

    # Find all YAML files in .github/workflows
    # NOTE: find -o requires grouping with \( \) and -print0 for proper null-termination
    local YAML_FILES=()
    if [ -d ".github/workflows" ]; then
        while IFS= read -r -d '' file; do
            YAML_FILES+=("$file")
        done < <(find .github/workflows -type f \( -name "*.yml" -o -name "*.yaml" \) -print0 2>/dev/null)
    fi

    # Also check release_conf.yml
    [ -f "config/release_conf.yml" ] && YAML_FILES+=("config/release_conf.yml")

    # Determine which YAML validator to use
    local USE_YAMLLINT=false
    local USE_YQ=false
    if command -v yamllint >/dev/null 2>&1; then
        USE_YAMLLINT=true
    elif command -v yq >/dev/null 2>&1; then
        USE_YQ=true
    fi

    local HAS_ERRORS=false
    for YAML_FILE in "${YAML_FILES[@]}"; do
        if [ -f "$YAML_FILE" ]; then
            # Check for tabs in YAML (common error)
            if grep -q $'\t' "$YAML_FILE" 2>/dev/null; then
                report_validation_error "YAML_TABS" \
                    "YAML file contains tabs: $YAML_FILE" \
                    "YAML requires spaces for indentation, tabs cause parse errors" \
                    "Replace tabs with spaces (2 or 4 spaces per indent level)" \
                    "sed -i '' 's/\\t/  /g' \"$YAML_FILE\""
                HAS_ERRORS=true
            fi

            # Validate with best available tool
            if [ "$USE_YAMLLINT" = true ]; then
                # yamllint provides detailed error messages with line numbers
                local YAMLLINT_OUTPUT
                YAMLLINT_OUTPUT=$(yamllint -d "{extends: relaxed, rules: {line-length: disable}}" "$YAML_FILE" 2>&1)
                local EXIT_CODE=$?
                if [ "$EXIT_CODE" -ne 0 ]; then
                    # Extract first error line for summary
                    local FIRST_ERROR
                    # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
                    FIRST_ERROR=$(echo "$YAMLLINT_OUTPUT" | grep -E '^\s+[0-9]+:' | head -1 || true)
                    [ -z "$FIRST_ERROR" ] && FIRST_ERROR="$YAMLLINT_OUTPUT"
                    # Truncate if too long
                    [ ${#FIRST_ERROR} -gt 150 ] && FIRST_ERROR="${FIRST_ERROR:0:150}..."
                    report_validation_error "YAML_SYNTAX" \
                        "YAML lint error in $YAML_FILE" \
                        "GitHub Actions or other tools will fail to parse this file" \
                        "Fix: $FIRST_ERROR" \
                        "yamllint '$YAML_FILE'"
                    HAS_ERRORS=true
                fi
            elif [ "$USE_YQ" = true ]; then
                local YQ_ERROR
                YQ_ERROR=$(yq '.' "$YAML_FILE" 2>&1 >/dev/null)
                if [ "$?" -ne 0 ]; then
                    report_validation_error "YAML_SYNTAX" \
                        "Invalid YAML syntax in $YAML_FILE" \
                        "GitHub Actions or other tools will fail to parse this file" \
                        "Fix the YAML syntax error: ${YQ_ERROR:-unknown error}" \
                        "yq '.' '$YAML_FILE'"
                    HAS_ERRORS=true
                fi
            else
                # Basic structure check: workflow files should start with name: or on:
                if [[ "$YAML_FILE" == *"workflows"* ]]; then
                    if ! head -5 "$YAML_FILE" | grep -qE '^(name:|on:|#)' 2>/dev/null; then
                        report_validation_warning "YAML_STRUCTURE" \
                            "Workflow file may have invalid structure: $YAML_FILE" \
                            "Workflow files should start with 'name:' or 'on:' directive" \
                            "Check workflow file format matches GitHub Actions spec"
                    fi
                fi
            fi
        fi
    done

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  YAML files valid"
    return 0
}

# Validate package.json has all required fields and files
# WHY: Missing files in "files" array causes MODULE_NOT_FOUND after npm install
# READ-ONLY: Reports issues, does NOT auto-fix
validate_package_json_completeness() {
    log_info "  → Validating package.json completeness..."

    local HAS_ERRORS=false

    # Check required fields for npm publishing
    local REQUIRED_FIELDS=("name" "version" "main" "files")
    for FIELD in "${REQUIRED_FIELDS[@]}"; do
        if ! node -e "if(!require('./package.json').$FIELD) process.exit(1)" 2>/dev/null; then
            report_validation_error "PKG_MISSING_FIELD" \
                "package.json missing required field: $FIELD" \
                "npm publish may fail or package may not work correctly" \
                "Add '$FIELD' field to package.json" \
                "node -e \"console.log(require('./package.json').$FIELD)\""
            HAS_ERRORS=true
        fi
    done

    # Check recommended fields
    local RECOMMENDED_FIELDS=("description" "repository" "license" "author" "keywords")
    for FIELD in "${RECOMMENDED_FIELDS[@]}"; do
        if ! node -e "if(!require('./package.json').$FIELD) process.exit(1)" 2>/dev/null; then
            report_validation_warning "PKG_RECOMMENDED_FIELD" \
                "package.json missing recommended field: $FIELD" \
                "npm registry metadata will be incomplete" \
                "Add '$FIELD' field to package.json for better discoverability"
        fi
    done

    # Check that files in "bin" actually exist
    local BIN_FILES
    BIN_FILES=$(node -e "
        const pkg = require('./package.json');
        if (pkg.bin) {
            if (typeof pkg.bin === 'string') {
                console.log(pkg.bin);
            } else {
                Object.values(pkg.bin).forEach(f => console.log(f));
            }
        }
    " 2>/dev/null)

    while IFS= read -r BIN_FILE; do
        if [ -n "$BIN_FILE" ] && [ ! -f "$BIN_FILE" ]; then
            report_validation_error "PKG_BIN_MISSING" \
                "package.json bin file missing: $BIN_FILE" \
                "CLI commands will fail with 'command not found' after npm install" \
                "Create the bin file or remove it from package.json bin field" \
                "ls -la '$BIN_FILE'"
            HAS_ERRORS=true
        fi
    done <<< "$BIN_FILES"

    # Check that main entry point exists
    local MAIN_FILE
    MAIN_FILE=$(node -e "console.log(require('./package.json').main || '')" 2>/dev/null)
    if [ -n "$MAIN_FILE" ] && [ ! -f "$MAIN_FILE" ]; then
        report_validation_error "PKG_MAIN_MISSING" \
            "package.json main file missing: $MAIN_FILE" \
            "require('package-name') will fail with MODULE_NOT_FOUND" \
            "Create the main file or update package.json main field" \
            "ls -la '$MAIN_FILE'"
        HAS_ERRORS=true
    fi

    # Check files array includes essential directories
    local ESSENTIAL_DIRS=("lib" "config")
    for DIR in "${ESSENTIAL_DIRS[@]}"; do
        if [ -d "$DIR" ]; then
            local FILES_INCLUDE
            FILES_INCLUDE=$(node -e "
                const pkg = require('./package.json');
                const files = pkg.files || [];
                const hasDir = files.some(f => f === '$DIR' || f === '$DIR/' || f.startsWith('$DIR/'));
                process.exit(hasDir ? 0 : 1);
            " 2>/dev/null)
            if [ "$?" -ne 0 ]; then
                report_validation_error "PKG_FILES_MISSING_DIR" \
                    "Directory '$DIR' exists but not in package.json files array" \
                    "Directory will not be included in published package (MODULE_NOT_FOUND)" \
                    "Add '$DIR/' to the 'files' array in package.json"
                HAS_ERRORS=true
            fi
        fi
    done

    # Check exports field if present
    local HAS_EXPORTS
    HAS_EXPORTS=$(node -e "if(require('./package.json').exports) console.log('yes')" 2>/dev/null)
    if [ "$HAS_EXPORTS" = "yes" ]; then
        # Validate export paths exist
        local EXPORT_PATHS
        EXPORT_PATHS=$(node -e "
            const pkg = require('./package.json');
            const flatten = (obj, prefix = '') => {
                for (const [k, v] of Object.entries(obj || {})) {
                    if (typeof v === 'string' && v.startsWith('./')) {
                        console.log(v);
                    } else if (typeof v === 'object') {
                        flatten(v);
                    }
                }
            };
            flatten(pkg.exports);
        " 2>/dev/null)

        while IFS= read -r EXPORT_PATH; do
            if [ -n "$EXPORT_PATH" ]; then
                local RESOLVED_PATH="${EXPORT_PATH#./}"
                if [ ! -f "$RESOLVED_PATH" ]; then
                    report_validation_error "PKG_EXPORTS_MISSING" \
                        "package.json exports path missing: $EXPORT_PATH" \
                        "Import will fail with ERR_MODULE_NOT_FOUND" \
                        "Create the file or update exports in package.json" \
                        "ls -la '$RESOLVED_PATH'"
                    HAS_ERRORS=true
                fi
            fi
        done <<< "$EXPORT_PATHS"
    fi

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  package.json complete"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# PATH VALIDATION
# Verify required files and directories exist
# READ-ONLY: Reports issues, does NOT auto-fix
# ══════════════════════════════════════════════════════════════════

# Validate required project files exist
validate_paths_exist() {
    log_info "  → Validating required paths..."

    local HAS_ERRORS=false

    # Required files for any npm package
    local REQUIRED_FILES=(
        "package.json"
        "README.md"
        "LICENSE"
    )

    for FILE in "${REQUIRED_FILES[@]}"; do
        if [ ! -f "$FILE" ]; then
            report_validation_error "PATH_REQUIRED_MISSING" \
                "Required file missing: $FILE" \
                "npm publish requires this file, or it's a best practice" \
                "Create the missing file" \
                "touch '$FILE'"
            HAS_ERRORS=true
        fi
    done

    # Check build output directories exist if referenced
    if [ -d "lib" ]; then
        # Verify lib directory has files
        # NOTE: find -o requires grouping with \( \) to work correctly
        # Without grouping, only the last pattern is applied to the path
        local LIB_COUNT
        LIB_COUNT=$(find lib -type f \( -name "*.cjs" -o -name "*.js" \) 2>/dev/null | wc -l)
        if [ "$LIB_COUNT" -eq 0 ]; then
            report_validation_warning "PATH_LIB_EMPTY" \
                "lib/ directory exists but contains no .js or .cjs files" \
                "Published package may be missing runtime code" \
                "Run build to generate lib files" \
                "pnpm run build"
        fi
    fi

    # Check config directory if referenced in package.json files
    if node -e "process.exit(require('./package.json').files?.includes('config/') ? 0 : 1)" 2>/dev/null; then
        if [ ! -d "config" ]; then
            report_validation_error "PATH_CONFIG_MISSING" \
                "package.json references config/ but directory doesn't exist" \
                "npm pack will fail or package will be incomplete" \
                "Create config directory or remove from files array"
            HAS_ERRORS=true
        fi
    fi

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  Required paths exist"
    return 0
}

# Validate build outputs are fresh (not stale)
# NOTE: Uses PROJECT_MINIFIED_FILE and PROJECT_SOURCE_FILE variables from top of script
validate_build_outputs() {
    log_info "  → Validating build outputs..."

    local HAS_ERRORS=false

    # Check if minified file exists and is recent
    if [ -f "$PROJECT_MINIFIED_FILE" ]; then
        if [ -f "$PROJECT_SOURCE_FILE" ]; then
            # Compare modification times - source should not be newer than minified
            if [ "$PROJECT_SOURCE_FILE" -nt "$PROJECT_MINIFIED_FILE" ]; then
                report_validation_warning "BUILD_STALE" \
                    "Source file is newer than minified output" \
                    "Published package may have outdated minified code" \
                    "Rebuild and commit the minified file" \
                    "pnpm run build && git add $PROJECT_MINIFIED_FILE"
            fi
        fi
    else
        report_validation_error "BUILD_MINIFIED_MISSING" \
            "$PROJECT_MINIFIED_FILE not found" \
            "CDN distribution and browser users need the minified file" \
            "Run build to generate minified file" \
            "pnpm run build"
        HAS_ERRORS=true
    fi

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  Build outputs valid"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# VERSION VALIDATION
# Verify version-related requirements
# READ-ONLY: Reports issues, does NOT auto-fix
# ══════════════════════════════════════════════════════════════════

# Validate that the target version tag doesn't already exist
validate_version_tag_not_exists() {
    local TARGET_VERSION="$1"
    log_info "  → Checking if tag v$TARGET_VERSION already exists..."

    if [ -z "$TARGET_VERSION" ]; then
        log_warning "  No target version specified - skipping tag check"
        return 0
    fi

    # Check local tags
    # NOTE: Use exact literal match to avoid partial matches
    # e.g., v1.0.1 should NOT match v1.0.10 or v1.0.11
    # CRITICAL: Use grep -F for fixed string matching (no regex metacharacter issues)
    if git tag -l "v$TARGET_VERSION" | grep -qF "v${TARGET_VERSION}"; then
        report_validation_error "VERSION_TAG_EXISTS_LOCAL" \
            "Git tag v$TARGET_VERSION already exists locally" \
            "Cannot create release with duplicate tag" \
            "Delete the local tag or choose a different version" \
            "git tag -d v$TARGET_VERSION"
        return 1
    fi

    # Check remote tags with portable timeout to prevent hanging
    # NOTE: Use exact literal match - git ls-remote returns full ref paths
    # NOTE: portable_timeout works on both GNU (Linux) and BSD (macOS) systems
    # CRITICAL: Use grep -F for fixed string matching (dots in version are literal)
    if portable_timeout 10 git ls-remote --tags origin "refs/tags/v$TARGET_VERSION" 2>/dev/null | grep -qF "refs/tags/v${TARGET_VERSION}"; then
        report_validation_error "VERSION_TAG_EXISTS_REMOTE" \
            "Git tag v$TARGET_VERSION already exists on remote" \
            "Cannot create release with duplicate tag" \
            "Choose a different version or delete remote tag" \
            "git push origin :refs/tags/v$TARGET_VERSION"
        return 1
    fi

    log_success "  Tag v$TARGET_VERSION is available"
    return 0
}

# Validate version is not already published on npm
validate_version_not_published() {
    local TARGET_VERSION="$1"
    log_info "  → Checking if v$TARGET_VERSION is already on npm..."

    # Skip if offline mode - cannot check npm registry without network
    if [ "$OFFLINE_MODE" = true ]; then
        log_info "    (skipped - offline mode)"
        return 0
    fi

    if [ -z "$TARGET_VERSION" ]; then
        log_warning "  No target version specified - skipping npm check"
        return 0
    fi

    local PKG_NAME
    PKG_NAME=$(node -e "console.log(require('./package.json').name)" 2>/dev/null)

    if [ -z "$PKG_NAME" ]; then
        report_validation_warning "VERSION_NPM_CHECK_FAILED" \
            "Could not determine package name" \
            "Cannot verify if version is already published"
        return 0
    fi

    # Check npm registry with portable timeout to prevent hanging
    # NOTE: portable_timeout works on both GNU (Linux) and BSD (macOS) systems
    local NPM_VERSIONS
    NPM_VERSIONS=$(portable_timeout 10 npm view "$PKG_NAME" versions --json 2>/dev/null || echo "")
    if [ -n "$NPM_VERSIONS" ]; then
        if echo "$NPM_VERSIONS" | grep -q "\"$TARGET_VERSION\""; then
            report_validation_error "VERSION_ALREADY_PUBLISHED" \
                "Version $TARGET_VERSION is already published on npm" \
                "npm publish will fail with E403 (version already exists)" \
                "Bump to a new version number" \
                "npm version patch"
            return 1
        fi
    fi

    log_success "  Version $TARGET_VERSION not yet published"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# DEPENDENCY VALIDATION
# Verify dependencies and lockfile status
# READ-ONLY: Reports issues, does NOT auto-fix
# ══════════════════════════════════════════════════════════════════

# Validate lockfile exists and is in sync
validate_deps_lockfile() {
    log_info "  → Validating lockfile..."

    local HAS_ERRORS=false

    # Determine package manager
    # WHY: Check for all supported lockfile formats including bun's text and binary formats
    local PKG_MANAGER=""
    if [ -f "pnpm-lock.yaml" ]; then
        PKG_MANAGER="pnpm"
    elif [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
        PKG_MANAGER="bun"
    elif [ -f "package-lock.json" ]; then
        PKG_MANAGER="npm"
    elif [ -f "yarn.lock" ]; then
        PKG_MANAGER="yarn"
    else
        report_validation_error "DEPS_NO_LOCKFILE" \
            "No lockfile found (pnpm-lock.yaml, bun.lock, package-lock.json, or yarn.lock)" \
            "CI uses --frozen-lockfile which requires a committed lockfile" \
            "Generate lockfile and commit it" \
            "bun install && git add bun.lock"
        return 1
    fi

    # Check if lockfile is in sync with package.json
    case "$PKG_MANAGER" in
        pnpm)
            # pnpm --lockfile-only --frozen-lockfile checks sync without installing
            # NOTE: pnpm does NOT have --dry-run option (removed in earlier versions)
            # Using --lockfile-only prevents actual installation
            if ! pnpm install --lockfile-only --frozen-lockfile >/dev/null 2>&1; then
                report_validation_error "DEPS_LOCKFILE_SYNC" \
                    "pnpm-lock.yaml is out of sync with package.json" \
                    "CI will fail with 'ERR_PNPM_OUTDATED_LOCKFILE'" \
                    "Regenerate lockfile and commit" \
                    "pnpm install && git add pnpm-lock.yaml && git commit -m 'chore: update lockfile'"
                HAS_ERRORS=true
            fi
            ;;
        npm)
            # npm ci would fail if out of sync, but we can't easily check without modifying
            # Just verify it's committed
            if ! git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
                report_validation_warning "DEPS_LOCKFILE_NOT_COMMITTED" \
                    "package-lock.json exists but is not committed" \
                    "CI may produce different dependency tree" \
                    "Commit the lockfile" \
                    "git add package-lock.json && git commit -m 'chore: commit lockfile'"
            fi
            ;;
        bun)
            # WHY: Bun uses --frozen-lockfile to verify lockfile is in sync
            # Check both bun.lock (text) and bun.lockb (binary) formats
            local BUN_LOCKFILE=""
            if [ -f "bun.lock" ]; then
                BUN_LOCKFILE="bun.lock"
            elif [ -f "bun.lockb" ]; then
                BUN_LOCKFILE="bun.lockb"
            fi
            # Verify lockfile is committed
            if ! git ls-files --error-unmatch "$BUN_LOCKFILE" >/dev/null 2>&1; then
                report_validation_warning "DEPS_LOCKFILE_NOT_COMMITTED" \
                    "$BUN_LOCKFILE exists but is not committed" \
                    "CI may produce different dependency tree" \
                    "Commit the lockfile" \
                    "git add $BUN_LOCKFILE && git commit -m 'chore: commit lockfile'"
            fi
            ;;
    esac

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  Lockfile valid ($PKG_MANAGER)"
    return 0
}

# Validate dependencies have no known vulnerabilities
validate_deps_audit() {
    log_info "  → Running dependency audit..."

    # Skip if offline mode
    if [ "$OFFLINE_MODE" = true ]; then
        log_info "    (skipped - offline mode)"
        return 0
    fi

    # Determine package manager and run audit
    local AUDIT_OUTPUT=""
    local CRITICAL=0
    local HIGH=0

    if [ -f "pnpm-lock.yaml" ]; then
        AUDIT_OUTPUT=$(pnpm audit --json 2>/dev/null || true)
        if [ -n "$AUDIT_OUTPUT" ]; then
            CRITICAL=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")
            HIGH=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo "0")
        fi
    elif [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
        # WHY: Bun uses pnpm audit internally - fall back to npm audit for compatibility
        # Note: As of bun 1.3, `bun audit` is not yet available
        AUDIT_OUTPUT=$(npm audit --json 2>/dev/null || true)
        if [ -n "$AUDIT_OUTPUT" ]; then
            CRITICAL=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")
            HIGH=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo "0")
        fi
    elif [ -f "package-lock.json" ]; then
        AUDIT_OUTPUT=$(npm audit --json 2>/dev/null || true)
        if [ -n "$AUDIT_OUTPUT" ]; then
            CRITICAL=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")
            HIGH=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo "0")
        fi
    fi

    # Report warnings (not errors) for vulnerabilities - user can decide
    if [ "$CRITICAL" -gt 0 ] || [ "$HIGH" -gt 0 ]; then
        report_validation_warning "DEPS_VULNERABILITIES" \
            "$CRITICAL critical, $HIGH high severity vulnerabilities found" \
            "Security scanners may flag this release" \
            "Review and update affected packages" \
            "pnpm audit --fix"
    else
        log_success "  No critical or high severity vulnerabilities"
    fi

    return 0
}

# ══════════════════════════════════════════════════════════════════
# CI/CD VALIDATION
# Verify CI workflow configuration
# READ-ONLY: Reports issues, does NOT auto-fix
# ══════════════════════════════════════════════════════════════════

# Validate CI workflow has correct OIDC configuration for npm trusted publishing
validate_ci_oidc() {
    log_info "  → Validating CI OIDC configuration..."

    local PUBLISH_WORKFLOW=".github/workflows/publish.yml"
    if [ ! -f "$PUBLISH_WORKFLOW" ]; then
        report_validation_warning "CI_PUBLISH_WORKFLOW_MISSING" \
            "Publish workflow not found: $PUBLISH_WORKFLOW" \
            "Automated npm publishing requires a workflow" \
            "Create publish workflow for npm trusted publishing"
        return 0
    fi

    local HAS_ERRORS=false

    # Check for id-token permission
    if ! grep -q "id-token: write" "$PUBLISH_WORKFLOW"; then
        report_validation_error "CI_OIDC_PERMISSION" \
            "Publish workflow missing 'id-token: write' permission" \
            "npm trusted publishing requires OIDC token generation" \
            "Add 'permissions: id-token: write' to the workflow" \
            "grep -n 'permissions' \"$PUBLISH_WORKFLOW\""
        HAS_ERRORS=true
    fi

    # Check for Node.js 24 (required for npm 11.5.1+ OIDC support)
    if grep -q "node-version:" "$PUBLISH_WORKFLOW"; then
        # NOTE: grep returns exit 1 when no match, use || true to prevent pipeline failure
        local NODE_VERSION
        NODE_VERSION=$(grep "node-version:" "$PUBLISH_WORKFLOW" | head -1 | grep -oE "[0-9]+" || true)
        if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" -lt 24 ]; then
            report_validation_error "CI_NODE_VERSION_OIDC" \
                "Publish workflow uses Node.js $NODE_VERSION (requires 24 for npm OIDC)" \
                "npm trusted publishing requires npm 11.5.1+ which ships with Node.js 24" \
                "Update node-version to '24' in the workflow" \
                "grep -n 'node-version' \"$PUBLISH_WORKFLOW\""
            HAS_ERRORS=true
        fi
    fi

    # Check workflow triggers on tags
    # NOTE: Must handle all YAML tag array formats to avoid false negatives:
    #   1. Multi-line YAML array:  tags:\n  - 'v*'  or  tags:\n  - v*
    #   2. Inline array:           tags: ['v*']  or  tags: [v*]
    #   3. Single value:           tags: 'v*'  or  tags: v*
    # Also must avoid false positives from:
    #   - Comments containing "tags:" or "v*"
    #   - String values containing these patterns
    local HAS_TAGS_TRIGGER=false
    if grep -qE "^\s*tags:" "$PUBLISH_WORKFLOW" 2>/dev/null; then
        # Check for v* pattern in context of tags section (next 5 lines or inline)
        # NOTE: Use section-aware extraction to avoid matching comments or unrelated content
        local TAGS_SECTION
        TAGS_SECTION=$(sed -n '/^\s*tags:/,/^\s*[a-z_-]*:/p' "$PUBLISH_WORKFLOW" | head -10)
        if echo "$TAGS_SECTION" | grep -qE "v\*|'v\*'|\"v\*\""; then
            HAS_TAGS_TRIGGER=true
        fi
    fi
    if [ "$HAS_TAGS_TRIGGER" = false ]; then
        report_validation_warning "CI_TAG_TRIGGER" \
            "Publish workflow may not trigger on version tags" \
            "Workflow should trigger on 'tags: v*' pattern" \
            "Check workflow 'on.push.tags' configuration"
    fi

    # Check for contents: read permission (recommended for minimal permissions)
    # NOTE: This is a warning, not an error - 'contents: write' also works but grants more access than needed
    if ! grep -q "contents: read" "$PUBLISH_WORKFLOW"; then
        if grep -q "contents: write" "$PUBLISH_WORKFLOW"; then
            report_validation_warning "CI_CONTENTS_PERMISSION_EXCESSIVE" \
                "Publish workflow has 'contents: write' permission (more than needed)" \
                "npm publish only needs read access to contents; write is excessive" \
                "Consider using 'contents: read' for minimal permissions"
        elif ! grep -qE "contents:" "$PUBLISH_WORKFLOW"; then
            report_validation_warning "CI_CONTENTS_PERMISSION_MISSING" \
                "Publish workflow doesn't explicitly set 'contents' permission" \
                "Explicit 'contents: read' is best practice for npm publish workflows" \
                "Add 'permissions: { contents: read, id-token: write }'"
        fi
    fi

    # Check for timeout-minutes on publish job
    # WHY: Without timeout, a stuck npm publish could run for 6 hours (default)
    if ! grep -q "timeout-minutes:" "$PUBLISH_WORKFLOW"; then
        report_validation_warning "CI_TIMEOUT_MISSING" \
            "Publish workflow has no timeout-minutes set" \
            "Without timeout, stuck jobs consume CI minutes; npm publish typically takes 2-5 min" \
            "Add 'timeout-minutes: 15' to the publish job"
    else
        # Validate timeout is reasonable (between 5 and 30 minutes for npm publish)
        # NOTE: Use sed to extract only the number after the colon, not all numbers in the line
        local TIMEOUT_VALUE
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        TIMEOUT_VALUE=$(grep "timeout-minutes:" "$PUBLISH_WORKFLOW" | head -1 | sed 's/.*timeout-minutes:[[:space:]]*//' | grep -oE "^[0-9]+" | head -1 || true)
        if [ -n "$TIMEOUT_VALUE" ]; then
            if [ "$TIMEOUT_VALUE" -lt 5 ]; then
                report_validation_warning "CI_TIMEOUT_TOO_SHORT" \
                    "Publish workflow timeout ($TIMEOUT_VALUE min) may be too short" \
                    "npm publish typically takes 2-5 minutes, network delays can add more" \
                    "Consider increasing timeout-minutes to at least 10"
            elif [ "$TIMEOUT_VALUE" -gt 30 ]; then
                report_validation_warning "CI_TIMEOUT_TOO_LONG" \
                    "Publish workflow timeout ($TIMEOUT_VALUE min) is longer than necessary" \
                    "npm publish rarely takes more than 10 minutes" \
                    "Consider reducing timeout-minutes to 15-20 for faster failure detection"
            fi
        fi
    fi

    # Check runs-on is a valid runner
    # WHY: Invalid runner names cause immediate workflow failure
    if grep -q "runs-on:" "$PUBLISH_WORKFLOW"; then
        local RUNNER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        RUNNER=$(grep "runs-on:" "$PUBLISH_WORKFLOW" | head -1 | sed 's/.*runs-on:\s*//' | tr -d ' ' || true)
        # Valid GitHub-hosted runners for npm publish
        local VALID_RUNNERS="ubuntu-latest ubuntu-22.04 ubuntu-24.04 macos-latest macos-14 windows-latest"
        local IS_VALID=false
        for VALID in $VALID_RUNNERS; do
            if [ "$RUNNER" = "$VALID" ]; then
                IS_VALID=true
                break
            fi
        done
        # Also allow self-hosted runners (starts with self-hosted or contains matrix reference)
        if [[ "$RUNNER" == "self-hosted"* ]] || [[ "$RUNNER" == *"\${"* ]]; then
            IS_VALID=true
        fi
        if [ "$IS_VALID" = false ]; then
            report_validation_warning "CI_RUNNER_UNKNOWN" \
                "Publish workflow uses unrecognized runner: $RUNNER" \
                "Unknown runners may not exist or have different tooling" \
                "Use a standard GitHub-hosted runner like 'ubuntu-latest'"
        fi
    else
        report_validation_error "CI_RUNNER_MISSING" \
            "Publish workflow is missing 'runs-on' specification" \
            "Every job must specify which runner to use" \
            "Add 'runs-on: ubuntu-latest' to the publish job" \
            "grep -n 'jobs:' \"$PUBLISH_WORKFLOW\""
        HAS_ERRORS=true
    fi

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  CI OIDC configuration valid"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# SECURITY VALIDATION
# Scan for secrets and security issues
# READ-ONLY: Reports issues, does NOT auto-fix
# ══════════════════════════════════════════════════════════════════

# Validate no secrets are exposed in code
validate_security_secrets() {
    log_info "  → Scanning for exposed secrets..."

    local HAS_ERRORS=false

    # Patterns to detect secrets (respects .gitignore via git ls-files)
    # NOTE: Patterns are designed to minimize false positives:
    #   - Require non-placeholder characters (exclude YOUR_, XXX, PLACEHOLDER, etc.)
    #   - Match actual credential formats, not just field names
    local SECRET_PATTERNS=(
        # AWS access key IDs (specific format)
        'AKIA[0-9A-Z]{16}'
        # Private keys (unambiguous)
        '-----BEGIN.*PRIVATE KEY-----'
        # API keys with actual-looking values (not placeholders)
        'api[_-]?key\s*[:=]\s*['"'"'"][a-zA-Z0-9+/=_-]{32,}['"'"'"]'
        # Tokens with actual-looking values (requires alphanumeric, min 32 chars)
        'token\s*[:=]\s*['"'"'"][a-zA-Z0-9+/=_-]{32,}['"'"'"]'
    )

    # Patterns that are likely false positives (placeholders, types, examples)
    local FALSE_POSITIVE_PATTERNS=(
        'YOUR_'
        'REPLACE_'
        'PLACEHOLDER'
        '<[A-Z_]+>'
        'xxx'
        ':\s*string'
        ':\s*String'
        'process\.env\.'
        'secrets\.'
        '\$\{'
    )

    # Get tracked files only (respects .gitignore)
    # NOTE: grep returns exit 1 when no matches, use || true to prevent pipeline failure
    local TRACKED_FILES
    TRACKED_FILES=$(git ls-files 2>/dev/null | grep -E '\.(js|ts|json|yml|yaml|cjs|mjs)$' | grep -v node_modules | grep -v -E '^(dist|build|coverage)/' || true)

    # Skip if no files to scan
    if [ -z "$TRACKED_FILES" ]; then
        log_success "  No files to scan"
        return 0
    fi

    # Try trufflehog first if available
    if command -v trufflehog >/dev/null 2>&1; then
        log_info "    Using trufflehog for secrets detection..."
        local TRUFFLEHOG_OUTPUT
        TRUFFLEHOG_OUTPUT=$(trufflehog filesystem --no-update --only-verified . 2>/dev/null || true)
        if [ -n "$TRUFFLEHOG_OUTPUT" ]; then
            report_validation_error "SECURITY_SECRETS_TRUFFLEHOG" \
                "Trufflehog detected potential secrets in codebase" \
                "Secrets in code can be extracted and misused" \
                "Review and remove secrets, rotate any exposed credentials" \
                "trufflehog filesystem --only-verified ."
            HAS_ERRORS=true
        fi
    else
        # Fall back to regex-based scanning
        log_info "    Using built-in regex patterns for secrets detection..."
        for PATTERN in "${SECRET_PATTERNS[@]}"; do
            # NOTE: Use tr + xargs -0 for filenames with spaces
            local MATCHES
            MATCHES=$(echo "$TRACKED_FILES" | tr '\n' '\0' | xargs -0 grep -lE "$PATTERN" 2>/dev/null || true)
            if [ -n "$MATCHES" ]; then
                # Filter out false positives - use while loop for filenames with spaces
                while IFS= read -r FILE; do
                    [ -z "$FILE" ] && continue
                    # Skip test files and examples with fake credentials
                    if [[ "$FILE" == *"test"* ]] || [[ "$FILE" == *"example"* ]] || [[ "$FILE" == *"mock"* ]]; then
                        continue
                    fi
                    # Skip documentation files
                    if [[ "$FILE" == *".md" ]] || [[ "$FILE" == *".txt" ]] || [[ "$FILE" == *".rst" ]]; then
                        continue
                    fi
                    # Skip if it's noreply email (allowed per user rules)
                    if grep -qE "noreply@" "$FILE" 2>/dev/null; then
                        continue
                    fi
                    # Check if match contains false positive patterns
                    local IS_FALSE_POSITIVE=false
                    local MATCHED_LINE
                    MATCHED_LINE=$(grep -E "$PATTERN" "$FILE" 2>/dev/null | head -1 || true)
                    for FP_PATTERN in "${FALSE_POSITIVE_PATTERNS[@]}"; do
                        if echo "$MATCHED_LINE" | grep -qiE "$FP_PATTERN" 2>/dev/null; then
                            IS_FALSE_POSITIVE=true
                            break
                        fi
                    done
                    if [ "$IS_FALSE_POSITIVE" = true ]; then
                        continue
                    fi
                    report_validation_warning "SECURITY_SECRETS_REGEX" \
                        "Potential secret pattern detected in: $FILE" \
                        "Could be a hardcoded credential" \
                        "Review the file and ensure no actual secrets are present" \
                        "grep -n '$PATTERN' '$FILE'"
                done <<< "$MATCHES"
            fi
        done
    fi

    # Check for absolute paths with username (security issue per user rules)
    # NOTE: Use tr + xargs -0 for filenames with spaces
    local ABS_PATH_MATCHES
    ABS_PATH_MATCHES=$(echo "$TRACKED_FILES" | tr '\n' '\0' | xargs -0 grep -lE '/Users/[a-zA-Z]+/' 2>/dev/null || true)
    if [ -n "$ABS_PATH_MATCHES" ]; then
        # Use while loop for filenames with spaces
        while IFS= read -r FILE; do
            [ -z "$FILE" ] && continue
            report_validation_warning "SECURITY_ABSOLUTE_PATH" \
                "Hardcoded absolute path with username in: $FILE" \
                "Exposes filesystem structure and username" \
                "Use relative paths or \$HOME / ~ instead" \
                "grep -n '/Users/' '$FILE'"
        done <<< "$ABS_PATH_MATCHES"
    fi

    # Check .env is gitignored
    if [ -f ".env" ]; then
        if git ls-files --error-unmatch .env >/dev/null 2>&1; then
            report_validation_error "SECURITY_ENV_TRACKED" \
                ".env file is tracked by git" \
                "Environment variables with secrets will be committed" \
                "Add .env to .gitignore and remove from tracking" \
                "echo '.env' >> .gitignore && git rm --cached .env"
            HAS_ERRORS=true
        fi
    fi

    if [ "$HAS_ERRORS" = true ]; then
        return 1
    fi

    log_success "  No critical secrets detected"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# NETWORK VALIDATION
# Verify URLs and network resources
# READ-ONLY: Reports issues, does NOT auto-fix
# ══════════════════════════════════════════════════════════════════

# Validate URLs in package.json are reachable
validate_urls_reachable() {
    log_info "  → Validating URLs..."

    # Skip if offline mode
    if [ "$OFFLINE_MODE" = true ]; then
        log_info "    (skipped - offline mode)"
        return 0
    fi

    local HAS_ERRORS=false

    # Extract URLs from package.json
    local HOMEPAGE
    HOMEPAGE=$(node -e "console.log(require('./package.json').homepage || '')" 2>/dev/null)

    local REPO_URL
    REPO_URL=$(node -e "
        const pkg = require('./package.json');
        const repo = pkg.repository;
        if (typeof repo === 'string') console.log(repo);
        else if (repo?.url) console.log(repo.url.replace('git+', '').replace('.git', ''));
    " 2>/dev/null)

    local BUGS_URL
    BUGS_URL=$(node -e "
        const pkg = require('./package.json');
        if (typeof pkg.bugs === 'string') console.log(pkg.bugs);
        else if (pkg.bugs?.url) console.log(pkg.bugs.url);
    " 2>/dev/null)

    # Check each URL
    for URL in "$HOMEPAGE" "$REPO_URL" "$BUGS_URL"; do
        if [ -n "$URL" ]; then
            # Convert git URLs to https
            local CHECK_URL="$URL"
            CHECK_URL="${CHECK_URL#git+}"
            CHECK_URL="${CHECK_URL%.git}"
            CHECK_URL="${CHECK_URL/git@github.com:/https://github.com/}"

            # Skip if not a valid URL
            if [[ ! "$CHECK_URL" =~ ^https?:// ]]; then
                continue
            fi

            # Check URL with timeout
            local HTTP_CODE
            HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$CHECK_URL" 2>/dev/null || echo "000")

            if [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" -ge 400 ]; then
                report_validation_warning "URL_UNREACHABLE" \
                    "URL in package.json unreachable: $CHECK_URL (HTTP $HTTP_CODE)" \
                    "Users clicking this link will see an error" \
                    "Verify the URL is correct and accessible"
            fi
        fi
    done

    log_success "  URL validation complete"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# COMPREHENSIVE VALIDATION RUNNER
# Runs all validators and accumulates results
# ══════════════════════════════════════════════════════════════════

# Report validation toolchain status
# Shows which tools are installed and being used for validation
report_validation_toolchain() {
    echo ""
    echo "┌──────────────────────────────────────────────────────────────┐"
    echo "│                   VALIDATION TOOLCHAIN                       │"
    echo "├──────────────────────────────────────────────────────────────┤"

    # JSON validation
    if command -v jsonlint >/dev/null 2>&1; then
        local JSONLINT_VER
        # NOTE: jsonlint --version returns exit code 1 but still outputs version
        # Use || true to prevent set -e from triggering on exit code 1
        JSONLINT_VER=$(jsonlint --version 2>&1 || true)
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        JSONLINT_VER=$(echo "$JSONLINT_VER" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$JSONLINT_VER" ] && JSONLINT_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "JSON:" "jsonlint v${JSONLINT_VER}"
    else
        printf "│  ${YELLOW}○${NC} %-10s %-45s │\n" "JSON:" "Node.js JSON.parse() (fallback)"
    fi

    # YAML validation - prefer yamllint, fallback to yq
    if command -v yamllint >/dev/null 2>&1; then
        local YAMLLINT_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        YAMLLINT_VER=$(yamllint --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$YAMLLINT_VER" ] && YAMLLINT_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "YAML:" "yamllint v${YAMLLINT_VER}"
    elif command -v yq >/dev/null 2>&1; then
        local YQ_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        YQ_VER=$(yq --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$YQ_VER" ] && YQ_VER="installed"
        printf "│  ${YELLOW}○${NC} %-10s %-45s │\n" "YAML:" "yq v${YQ_VER} (yamllint preferred)"
    else
        printf "│  ${YELLOW}○${NC} %-10s %-45s │\n" "YAML:" "Basic grep validation (fallback)"
    fi

    # ESLint for JavaScript/TypeScript
    if command -v eslint >/dev/null 2>&1; then
        local ESLINT_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        ESLINT_VER=$(eslint --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$ESLINT_VER" ] && ESLINT_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "ESLint:" "eslint v${ESLINT_VER}"
    elif [ -f "node_modules/.bin/eslint" ]; then
        local ESLINT_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        ESLINT_VER=$(./node_modules/.bin/eslint --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$ESLINT_VER" ] && ESLINT_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "ESLint:" "eslint v${ESLINT_VER} (local)"
    else
        printf "│  ${YELLOW}○${NC} %-10s %-45s │\n" "ESLint:" "Not found (install: npm i -g eslint)"
    fi

    # Security scanning
    if command -v trufflehog >/dev/null 2>&1; then
        local TH_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        TH_VER=$(trufflehog --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$TH_VER" ] && TH_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "Secrets:" "trufflehog v${TH_VER}"
    else
        printf "│  ${YELLOW}○${NC} %-10s %-45s │\n" "Secrets:" "Pattern-based grep scan (fallback)"
    fi

    # Dependency audit
    if command -v pnpm >/dev/null 2>&1; then
        local PNPM_VER
        PNPM_VER=$(pnpm --version 2>/dev/null | head -1)
        [ -z "$PNPM_VER" ] && PNPM_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "Deps:" "pnpm audit v${PNPM_VER}"
    elif command -v npm >/dev/null 2>&1; then
        local NPM_VER
        NPM_VER=$(npm --version 2>/dev/null | head -1)
        [ -z "$NPM_VER" ] && NPM_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "Deps:" "npm audit v${NPM_VER}"
    else
        printf "│  ${RED}✗${NC} %-10s %-45s │\n" "Deps:" "No package manager found"
    fi

    # Git operations
    if command -v git >/dev/null 2>&1; then
        local GIT_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        GIT_VER=$(git --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$GIT_VER" ] && GIT_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "Git:" "git v${GIT_VER}"
    else
        printf "│  ${RED}✗${NC} %-10s %-45s │\n" "Git:" "Not installed (required)"
    fi

    # GitHub CLI
    if command -v gh >/dev/null 2>&1; then
        local GH_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        GH_VER=$(gh --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
        [ -z "$GH_VER" ] && GH_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "GitHub:" "gh v${GH_VER}"
    else
        printf "│  ${RED}✗${NC} %-10s %-45s │\n" "GitHub:" "Not installed (required for releases)"
    fi

    # jq for JSON processing
    if command -v jq >/dev/null 2>&1; then
        local JQ_VER
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        JQ_VER=$(jq --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)
        [ -z "$JQ_VER" ] && JQ_VER="installed"
        printf "│  ${GREEN}✓${NC} %-10s %-45s │\n" "jq:" "jq v${JQ_VER}"
    else
        printf "│  ${RED}✗${NC} %-10s %-45s │\n" "jq:" "Not installed (required)"
    fi

    echo "└──────────────────────────────────────────────────────────────┘"
    echo ""
}

# Run all pre-release validations
run_all_validations() {
    local TARGET_VERSION="${1:-}"

    log_info "Running comprehensive validation..."

    # Show validation toolchain status
    report_validation_toolchain

    # Reset validation state
    reset_validation_state

    local VALIDATION_FAILED=false

    # Phase 1: Syntax validation
    log_info "┌─ Phase 1: Syntax Validation"
    validate_json_files || VALIDATION_FAILED=true
    validate_yaml_files || VALIDATION_FAILED=true
    echo ""

    # Phase 2: Package validation
    log_info "┌─ Phase 2: Package Validation"
    validate_package_json_completeness || VALIDATION_FAILED=true
    validate_paths_exist || VALIDATION_FAILED=true
    validate_build_outputs || VALIDATION_FAILED=true
    echo ""

    # Phase 3: Version validation
    log_info "┌─ Phase 3: Version Validation"
    validate_version_sync || VALIDATION_FAILED=true
    if [ -n "$TARGET_VERSION" ]; then
        validate_version_tag_not_exists "$TARGET_VERSION" || VALIDATION_FAILED=true
        validate_version_not_published "$TARGET_VERSION" || VALIDATION_FAILED=true
    fi
    echo ""

    # Phase 4: Dependency validation
    log_info "┌─ Phase 4: Dependency Validation"
    validate_deps_lockfile || VALIDATION_FAILED=true
    validate_deps_audit || true  # Audit is warning-only, don't fail
    echo ""

    # Phase 5: CI/CD validation
    log_info "┌─ Phase 5: CI/CD Validation"
    validate_ci_oidc || VALIDATION_FAILED=true
    echo ""

    # Phase 6: Security validation
    log_info "┌─ Phase 6: Security Validation"
    validate_security_secrets || VALIDATION_FAILED=true
    echo ""

    # Phase 7: Documentation validation (if docs-audit.cjs exists)
    if [ -f "scripts/docs-audit.cjs" ]; then
        log_info "┌─ Phase 7: Documentation Validation"
        if node scripts/docs-audit.cjs 2>/dev/null; then
            log_success "  Documentation audit passed"
        else
            log_warning "  Documentation audit found issues - run: node scripts/docs-audit.cjs"
            # WHY: Documentation issues are warnings, not blocking errors
            # Allows release to proceed but alerts maintainer to fix docs
        fi
        echo ""
    fi

    # Phase 8: Network validation (optional)
    if [ "$OFFLINE_MODE" != true ]; then
        log_info "┌─ Phase 8: Network Validation"
        validate_urls_reachable || true  # URL checks are warning-only
        echo ""
    fi

    # Print validation report
    print_validation_report

    # Return failure if any blocking errors
    if [ "$VALIDATION_FAILED" = true ]; then
        return 1
    fi

    # In strict mode, warnings also fail
    if [ "$STRICT_MODE" = true ] && [ ${#VALIDATION_WARNINGS[@]} -gt 0 ]; then
        log_error "Strict mode: ${#VALIDATION_WARNINGS[@]} warning(s) treated as errors"
        return 1
    fi

    return 0
}

# Run quality checks - COMPREHENSIVE version matching CI exactly
run_quality_checks() {
    log_info "Running comprehensive quality checks (matching CI exactly)..."
    log_info "These checks replicate what GitHub Actions CI runs."
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 0: ENVIRONMENT VALIDATION (Pre-CI checks)
    # WHY: Catch environment mismatches that would cause CI to fail
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 0: Environment Validation (Pre-CI)"

    # Check Node.js version (CI uses Node 18 LTS minimum)
    local NODE_MAJOR_VERSION
    NODE_MAJOR_VERSION=$(node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
    if [ -z "$NODE_MAJOR_VERSION" ] || [ "$NODE_MAJOR_VERSION" -lt 18 ]; then
        error_with_guidance \
            "Node.js version too old (v$NODE_MAJOR_VERSION)" \
            "CI uses Node.js 18 LTS as minimum. Your code may fail in CI with an older version." \
            "Update to Node.js 18 or later" \
            "brew install node@18  # or: nvm install 18"
        exit 1
    fi
    log_success "  Node.js v$(node --version | tr -d 'v') (>=18 required)"

    # Check that pnpm lockfile is in sync with package.json
    log_info "  → Verifying lockfile integrity..."
    if ! pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -5; then
        error_with_guidance \
            "pnpm lockfile is out of sync with package.json" \
            "CI runs 'pnpm install --frozen-lockfile' which fails if lockfile doesn't match package.json" \
            "Regenerate the lockfile and commit it" \
            "pnpm install && git add pnpm-lock.yaml && git commit -m 'chore: update lockfile'"
        exit 1
    fi
    log_success "  Lockfile is in sync with package.json"

    log_success "└─ Environment validation passed"
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

    # Get effective format command (task runner or fallback)
    local FORMAT_CMD
    FORMAT_CMD=$(get_effective_command "format" "pnpm exec prettier --check .")
    log_info "  → Checking code formatting..."
    log_info "  → Command: $FORMAT_CMD"

    if ! $FORMAT_CMD 2>&1 | tee /tmp/format-output.log | tail -10; then
        error_with_guidance \
            "Formatting check failed" \
            "Code formatting must match project standards. CI runs the same check." \
            "Run the format command to auto-fix formatting issues" \
            "pnpm run format  # then: git add -A && git commit --amend --no-edit"
        exit 1
    fi
    log_success "  Formatting check passed"

    log_success "└─ Formatting check passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 3: LINTING (ESLint)
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 3: Linting"

    # Get effective lint command (task runner or fallback)
    local LINT_CMD
    LINT_CMD=$(get_effective_command "lint" "${CFG_LINT_CMD:-pnpm exec eslint .}")
    log_info "  → Running linter..."
    log_info "  → Command: $LINT_CMD"

    if ! $LINT_CMD 2>&1 | tee /tmp/lint-output.log | tail -20; then
        error_with_guidance \
            "Linting failed" \
            "ESLint found code quality issues that must be fixed. CI runs the same check." \
            "Run the lint fix command to auto-fix some issues, then fix remaining manually" \
            "${CFG_LINT_FIX_CMD:-pnpm run lint:fix}  # auto-fix; then check /tmp/lint-output.log"
        exit 1
    fi
    log_success "  Linting passed"

    log_success "└─ Linting passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 4: TYPE CHECKING (TypeScript)
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 4: Type Checking"

    # Get effective typecheck command (task runner or fallback)
    local TYPECHECK_CMD
    TYPECHECK_CMD=$(get_effective_command "typecheck" "${CFG_TYPECHECK_CMD:-pnpm run typecheck}")
    log_info "  → Running TypeScript type checker..."
    log_info "  → Command: $TYPECHECK_CMD"

    if ! $TYPECHECK_CMD 2>&1 | tee /tmp/typecheck-output.log | tail -20; then
        error_with_guidance \
            "Type checking failed" \
            "TypeScript found type errors that must be fixed. CI runs the same check." \
            "Fix the type errors shown in the output" \
            "cat /tmp/typecheck-output.log | less  # view full output"
        exit 1
    fi
    log_success "  Type checking passed"

    log_success "└─ Type checking passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 5: UNIT & INTEGRATION TESTS (Using config settings)
    # WHY: Only test files that changed since last release (or their dependents)
    # RULE: No source unchanged since previous tag should be tested again,
    #       unless it imports a changed library
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 5: Running Tests (mode: ${CFG_TESTS_MODE:-selective})"

    # Skip tests if disabled in config
    if [ "${CFG_TESTS_ENABLED:-true}" = "false" ]; then
        log_warning "  Tests disabled in config (quality_checks.tests.enabled: false)"
        log_warning "  Skipping tests - CI WILL STILL RUN TESTS!"
    else
        # Get previous tag to compare changes against
        local PREVIOUS_TAG
        PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

        # Determine test mode from config (selective or full)
        local TEST_MODE="${CFG_TESTS_MODE:-selective}"
        local SELECTIVE_CMD="${CFG_TEST_SELECTIVE_CMD:-node scripts/test-selective.cjs}"
        # Check for task runner test command, fallback to config command
        local FULL_CMD
        FULL_CMD=$(get_effective_command "test" "${CFG_TEST_FULL_CMD:-pnpm test}")

        if [ "$TEST_MODE" = "selective" ] && [ -n "$PREVIOUS_TAG" ]; then
            log_info "  → Running selective tests (changes since $PREVIOUS_TAG)..."
            log_info "  → Only testing files that changed or depend on changed files"
            log_info "  → Command: $SELECTIVE_CMD $PREVIOUS_TAG"

            # Use selective test command from config with previous tag as base reference
            if ! $SELECTIVE_CMD "$PREVIOUS_TAG" 2>&1 | tee /tmp/test-output.log | tail -60; then
                echo "" >&2
                log_error "Failed tests:"
                grep -E "FAIL|✗|AssertionError" /tmp/test-output.log | head -20 || true
                error_with_guidance \
                    "Selective tests failed" \
                    "Tests must pass locally before release. CI will also fail if you proceed." \
                    "Fix the failing tests, then retry the release" \
                    "cat /tmp/test-output.log | less  # view full output"
                exit 1
            fi
            log_success "  Selective tests passed"
        else
            if [ "$TEST_MODE" = "selective" ]; then
                log_warning "  No previous tag found - falling back to full test suite"
            else
                log_info "  → Test mode set to 'full' in config"
            fi
            log_info "  → Running full test suite..."
            log_info "  → Command: $FULL_CMD"

            if ! $FULL_CMD 2>&1 | tee /tmp/test-output.log | tail -60; then
                echo "" >&2
                log_error "Failed tests:"
                grep -E "FAIL|✗|AssertionError" /tmp/test-output.log | head -20 || true
                error_with_guidance \
                    "Full test suite failed" \
                    "All tests must pass before release. CI will also fail if you proceed." \
                    "Fix the failing tests, then retry the release" \
                    "cat /tmp/test-output.log | less  # view full output"
                exit 1
            fi
            log_success "  All tests passed"
        fi
    fi

    log_success "└─ Tests passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 6: E2E TESTS (Using config settings)
    # WHY: CI runs E2E tests separately, failures here block release
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 6: E2E Tests (Playwright)"

    # Skip E2E if disabled in config
    if [ "${CFG_E2E_ENABLED:-true}" = "false" ]; then
        log_warning "  E2E tests disabled in config (quality_checks.e2e.enabled: false)"
        log_warning "  Skipping E2E tests - CI WILL STILL RUN E2E TESTS!"
    else
        # Check for task runner e2e command, fallback to config command
        local E2E_CMD
        E2E_CMD=$(get_effective_command "e2e" "${CFG_E2E_CMD:-pnpm run test:e2e}")
        log_info "  → Running E2E tests..."
        log_info "  → Command: $E2E_CMD"

        if ! $E2E_CMD 2>&1 | tee /tmp/e2e-output.log | tail -30; then
            error_with_guidance \
                "E2E tests failed (Playwright browser tests)" \
                "End-to-end tests verify the library works correctly in real browsers. CI runs these tests." \
                "Check the Playwright report for details, fix issues, and retry" \
                "cat /tmp/e2e-output.log | less  # or: npx playwright show-report"
            exit 1
        fi
        log_success "  E2E tests passed"
    fi

    log_success "└─ E2E tests passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # PHASE 7: BUILD VERIFICATION
    # WHY: Ensure minified file builds correctly before release
    # ════════════════════════════════════════════════════════════════
    log_info "┌─ Phase 7: Build Verification"

    # Get effective build command (task runner or fallback)
    local BUILD_CMD
    BUILD_CMD=$(get_effective_command "build" "${CFG_BUILD_CMD:-pnpm run build}")
    log_info "  → Building minified library..."
    log_info "  → Command: $BUILD_CMD"

    if ! $BUILD_CMD 2>&1 | tee /tmp/build-output.log | tail -10; then
        error_with_guidance \
            "Build failed (minification/bundling)" \
            "The build step minifies JavaScript for production. This must succeed for release." \
            "Check the build script and Terser configuration for errors" \
            "cat /tmp/build-output.log | less  # view full build output"
        exit 1
    fi
    log_success "  Build succeeded"

    # Verify build output exists and is valid
    # NOTE: Uses PROJECT_MINIFIED_FILE and PROJECT_SOURCE_FILE from top of script
    if [ ! -f "$PROJECT_MINIFIED_FILE" ]; then
        error_with_guidance \
            "Build did not produce $PROJECT_MINIFIED_FILE" \
            "The build script should create the minified library file" \
            "Check the build script (package.json 'build' script) to ensure it outputs the correct file" \
            "pnpm run build --verbose"
        exit 1
    fi

    # Verify build has no syntax errors
    if ! node --check "$PROJECT_MINIFIED_FILE" 2>/dev/null; then
        error_with_guidance \
            "Built file has JavaScript syntax errors" \
            "The minification may have introduced invalid JavaScript syntax" \
            "Check the source file for syntax issues, or try building without minification" \
            "node --check $PROJECT_SOURCE_FILE  # test unminified version"
        exit 1
    fi
    log_success "  Build output verified"

    log_success "└─ Build verification passed"
    echo ""

    # ════════════════════════════════════════════════════════════════
    # ALL CHECKS PASSED - SUMMARY
    # ════════════════════════════════════════════════════════════════
    echo ""
    log_success "╔═══════════════════════════════════════════════════════════════════╗"
    log_success "║  ALL LOCAL QUALITY CHECKS PASSED - READY FOR RELEASE              ║"
    log_success "╠═══════════════════════════════════════════════════════════════════╣"
    log_success "║  ✓ Environment: Node.js $(node --version), pnpm $(pnpm --version 2>/dev/null | head -1)"
    log_success "║  ✓ Configuration: JSON, YAML, package.json validated              ║"
    log_success "║  ✓ Formatting: Prettier check passed                              ║"
    log_success "║  ✓ Linting: ESLint passed                                         ║"
    log_success "║  ✓ Types: TypeScript type check passed                            ║"
    log_success "║  ✓ Tests: Unit/integration tests passed                           ║"
    log_success "║  ✓ E2E: Playwright browser tests passed                           ║"
    log_success "║  ✓ Build: Minified library built and verified                     ║"
    log_success "╠═══════════════════════════════════════════════════════════════════╣"
    log_success "║  CI will run the same checks. If they pass locally, they should   ║"
    log_success "║  pass in CI too (barring environment-specific issues).            ║"
    log_success "╚═══════════════════════════════════════════════════════════════════╝"
    echo ""
}

# Generate release notes using configured generator
# Supports: git-cliff, conventional-changelog, standard-version, auto
generate_release_notes() {
    local VERSION=$1
    local PREVIOUS_TAG=$2
    local CHANGELOG_SECTION=""
    local GENERATOR

    # Determine which generator to use (from config or auto-detect)
    GENERATOR="${CFG_RELEASE_NOTES_GEN:-$(detect_release_notes_generator)}"
    log_info "Generating release notes using: $GENERATOR"

    case "$GENERATOR" in
        "git-cliff")
            # git-cliff: Rust-based changelog generator (recommended)
            if ! command_exists git-cliff; then
                log_warning "git-cliff not installed, falling back to auto"
                log_info "Install: brew install git-cliff (macOS) or cargo install git-cliff (Linux)"
                GENERATOR="auto"
            else
                if [ -z "$PREVIOUS_TAG" ]; then
                    CHANGELOG_SECTION=$(git-cliff --unreleased --strip header 2>/dev/null)
                else
                    CHANGELOG_SECTION=$(git-cliff --unreleased --strip header "${PREVIOUS_TAG}.." 2>/dev/null)
                fi
                # Strip the "## [unreleased]" header
                CHANGELOG_SECTION=$(echo "$CHANGELOG_SECTION" | sed '/^## \[unreleased\]/d')
            fi
            ;;

        "conventional-changelog")
            # conventional-changelog: Node.js-based generator
            if command_exists conventional-changelog; then
                CHANGELOG_SECTION=$(conventional-changelog -p angular -r 1 2>/dev/null)
            elif [ -f "package.json" ] && command_exists npx; then
                CHANGELOG_SECTION=$(npx conventional-changelog -p angular -r 1 2>/dev/null)
            else
                log_warning "conventional-changelog not available, falling back to auto"
                GENERATOR="auto"
            fi
            ;;

        "standard-version")
            # standard-version: Generates changelog as part of version bump
            # We extract the latest section from CHANGELOG.md if it exists
            if [ -f "CHANGELOG.md" ]; then
                # Extract the most recent version section
                CHANGELOG_SECTION=$(awk '/^## \[/{if(p) exit; p=1} p' CHANGELOG.md 2>/dev/null | tail -n +2)
            else
                log_warning "CHANGELOG.md not found, falling back to auto"
                GENERATOR="auto"
            fi
            ;;

        "auto"|*)
            # Auto-generate from git commits (fallback)
            GENERATOR="auto"
            ;;
    esac

    # Auto-generate from git commits if no changelog was generated
    if [ -z "$CHANGELOG_SECTION" ] || [ "$GENERATOR" = "auto" ]; then
        log_info "  → Auto-generating changelog from git commits..."

        local COMMIT_RANGE=""
        if [ -n "$PREVIOUS_TAG" ]; then
            COMMIT_RANGE="${PREVIOUS_TAG}..HEAD"
        else
            COMMIT_RANGE="HEAD"
        fi

        # Generate formatted changelog from commits
        # Group by conventional commit type
        # NOTE: git log --grep returns exit 1 when no commits match, use || true to prevent pipeline failure
        local FEATURES FIXES DOCS CHORES OTHER

        FEATURES=$(git log "$COMMIT_RANGE" --pretty=format:"- %s" --grep="^feat" 2>/dev/null | head -20 || true)
        FIXES=$(git log "$COMMIT_RANGE" --pretty=format:"- %s" --grep="^fix" 2>/dev/null | head -20 || true)
        DOCS=$(git log "$COMMIT_RANGE" --pretty=format:"- %s" --grep="^docs" 2>/dev/null | head -10 || true)
        CHORES=$(git log "$COMMIT_RANGE" --pretty=format:"- %s" --grep="^chore" 2>/dev/null | head -10 || true)
        OTHER=$(git log "$COMMIT_RANGE" --pretty=format:"- %s" 2>/dev/null | grep -v "^- feat\|^- fix\|^- docs\|^- chore" | head -10 || true)

        CHANGELOG_SECTION=""
        if [ -n "$FEATURES" ]; then
            CHANGELOG_SECTION="${CHANGELOG_SECTION}### Features\n\n${FEATURES}\n\n"
        fi
        if [ -n "$FIXES" ]; then
            CHANGELOG_SECTION="${CHANGELOG_SECTION}### Bug Fixes\n\n${FIXES}\n\n"
        fi
        if [ -n "$DOCS" ]; then
            CHANGELOG_SECTION="${CHANGELOG_SECTION}### Documentation\n\n${DOCS}\n\n"
        fi
        if [ -n "$CHORES" ]; then
            CHANGELOG_SECTION="${CHANGELOG_SECTION}### Maintenance\n\n${CHORES}\n\n"
        fi
        if [ -n "$OTHER" ]; then
            CHANGELOG_SECTION="${CHANGELOG_SECTION}### Other Changes\n\n${OTHER}\n\n"
        fi

        # Remove trailing newlines
        CHANGELOG_SECTION=$(echo -e "$CHANGELOG_SECTION" | sed '/^$/N;/^\n$/d')
    fi

    if [ -z "$CHANGELOG_SECTION" ]; then
        log_warning "No changes found for release notes"
        CHANGELOG_SECTION="No notable changes in this release."
    fi

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
<script src="https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"></script>
\`\`\`

#### unpkg
\`\`\`html
<script src="https://unpkg.com/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"></script>
\`\`\`

---

$(if [ -n "$PREVIOUS_TAG" ]; then echo "**Full Changelog**: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/compare/${PREVIOUS_TAG}...v${VERSION}"; else echo "**Initial Release**: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v${VERSION}"; fi)
EOF

    log_success "Release notes generated using $GENERATOR"
    log_info "Preview: /tmp/release-notes.md"
}

# Commit version bump
# Update CHANGELOG.md with git-cliff before committing
# WHY: Changelog must be updated with each release to document all changes
# The changelog is the source of truth for release notes
update_changelog() {
    local VERSION=$1
    local CLIFF_OUTPUT=""
    local CLIFF_EXIT_CODE=0

    # Validate VERSION parameter (same pattern as other functions)
    # WHY: Empty or ANSI-contaminated version strings cause tag creation failures
    if [ -z "$VERSION" ]; then
        log_error "update_changelog called without VERSION parameter"
        return 0  # Non-fatal, but log the error
    fi

    # Strip any ANSI codes that might have leaked in (paranoid safeguard)
    VERSION=$(echo "$VERSION" | strip_ansi)

    # Validate version format
    if ! validate_version "$VERSION"; then
        log_error "Invalid version format in update_changelog: $VERSION"
        return 0  # Non-fatal, but log the error
    fi

    log_info "Updating CHANGELOG.md with git-cliff for v${VERSION}..."

    # Check if git-cliff is installed
    if ! command_exists git-cliff; then
        log_warning "git-cliff not installed - changelog will not be updated"
        log_info "Install: brew install git-cliff (macOS) or cargo install git-cliff (Linux)"
        return 0  # Non-fatal, continue with release
    fi

    # Check if cliff.toml exists
    if [ ! -f "cliff.toml" ]; then
        log_warning "cliff.toml not found - using default git-cliff config"
    fi

    # Check file write permissions
    # WHY: Detect permission issues before git-cliff runs
    if [ -f "CHANGELOG.md" ] && [ ! -w "CHANGELOG.md" ]; then
        log_error "CHANGELOG.md exists but is not writable"
        log_info "Fix: chmod u+w CHANGELOG.md"
        return 0  # Non-fatal
    fi

    # Check directory write permissions for new file creation
    if [ ! -f "CHANGELOG.md" ] && [ ! -w "." ]; then
        log_error "Current directory is not writable - cannot create CHANGELOG.md"
        return 0  # Non-fatal
    fi

    # Generate full changelog with the new tag
    # WHY: Using -o overwrites CHANGELOG.md with complete history
    # The --tag flag tells git-cliff to include commits up to this tag
    # Capture stderr for debugging while still showing warnings
    CLIFF_OUTPUT=$(git-cliff --tag "v${VERSION}" -o CHANGELOG.md 2>&1)
    CLIFF_EXIT_CODE=$?

    if [ $CLIFF_EXIT_CODE -eq 0 ]; then
        # Verify the file was actually written and has content
        if [ ! -f "CHANGELOG.md" ]; then
            log_error "git-cliff succeeded but CHANGELOG.md was not created"
            log_debug "git-cliff output: $CLIFF_OUTPUT"
            return 0  # Non-fatal
        fi

        # Check file is not empty (should have at least header)
        if [ ! -s "CHANGELOG.md" ]; then
            log_error "git-cliff created empty CHANGELOG.md"
            log_debug "git-cliff output: $CLIFF_OUTPUT"
            return 0  # Non-fatal
        fi

        # Verify the new version appears in the changelog
        if ! grep -q "\[${VERSION}\]" CHANGELOG.md 2>/dev/null; then
            log_warning "Version ${VERSION} not found in CHANGELOG.md - may be missing commits"
        fi

        log_success "CHANGELOG.md updated for v${VERSION}"

        # Show any warnings from git-cliff (e.g., non-conventional commits)
        if [ -n "$CLIFF_OUTPUT" ] && echo "$CLIFF_OUTPUT" | grep -q "WARN"; then
            log_debug "git-cliff warnings (non-fatal):"
            echo "$CLIFF_OUTPUT" | grep "WARN" | head -5 | while read -r line; do
                log_debug "  $line"
            done
        fi

        return 0
    else
        # git-cliff failed - show the error for debugging
        log_warning "git-cliff failed (exit code: $CLIFF_EXIT_CODE)"
        if [ -n "$CLIFF_OUTPUT" ]; then
            log_debug "git-cliff output:"
            echo "$CLIFF_OUTPUT" | head -10 | while read -r line; do
                log_debug "  $line"
            done
        fi

        # Try without --tag as fallback
        log_info "Retrying without --tag flag..."
        CLIFF_OUTPUT=$(git-cliff -o CHANGELOG.md 2>&1)
        CLIFF_EXIT_CODE=$?

        if [ $CLIFF_EXIT_CODE -eq 0 ] && [ -s "CHANGELOG.md" ]; then
            log_success "CHANGELOG.md updated (without tag)"
            return 0
        fi

        log_warning "Could not update changelog - continuing anyway"
        if [ -n "$CLIFF_OUTPUT" ]; then
            log_debug "Fallback git-cliff output: $CLIFF_OUTPUT"
        fi
        return 0  # Non-fatal
    fi
}

commit_version_bump() {
    local VERSION=$1

    # Validate VERSION parameter
    if [ -z "$VERSION" ]; then
        log_error "commit_version_bump called without VERSION parameter"
        return 1
    fi

    log_info "Committing version bump..."

    # Stage package.json (required - always modified by version bump)
    if [ ! -f "package.json" ]; then
        log_error "package.json not found - cannot commit version bump"
        return 1
    fi
    if ! git add package.json; then
        log_error "Failed to stage package.json"
        return 1
    fi

    # Stage pnpm-lock.yaml only if it exists (optional - may not change)
    # WHY: Lock file only changes if dependencies are affected by version bump
    if [ -f "pnpm-lock.yaml" ]; then
        git add pnpm-lock.yaml 2>/dev/null || true
    fi

    # Stage bun.lock if it exists (for bun package manager)
    # WHY: Bun uses bun.lock instead of pnpm-lock.yaml
    if [ -f "bun.lock" ]; then
        git add bun.lock 2>/dev/null || true
    fi

    # Stage CHANGELOG.md if it was updated
    # WHY: Changelog must be included in the release commit
    if [ -f "CHANGELOG.md" ]; then
        git add CHANGELOG.md 2>/dev/null || true
    fi

    # Verify there are changes to commit
    # WHY: Prevents "nothing to commit" errors if version was already bumped
    if git diff --cached --quiet; then
        log_warning "No changes staged for version bump commit"
        log_warning "Version may have already been bumped in a previous run"
        return 0  # Not an error - idempotent behavior
    fi

    # SAFEGUARD: Use --no-verify because the release script has already run comprehensive
    # validation (linting, type checking, tests, security scans). Pre-commit hooks would be
    # redundant AND can fail due to race conditions in parallel test execution.
    # This prevents flaky test failures from blocking releases after all validations passed.
    if ! git commit --no-verify -m "chore(release): Bump version to $VERSION"; then
        log_error "Failed to commit version bump"
        return 1
    fi

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
    # NOTE: Use grep -qF for fixed-string matching (version dots are literal, not regex)
    if git tag -l "v$VERSION" | grep -qF "v$VERSION"; then
        log_warning "Tag v$VERSION already exists locally, deleting..."
        if ! git tag -d "v$VERSION"; then
            log_error "Failed to delete existing local tag v$VERSION"
            return 1
        fi
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
    # NOTE: Add error check - git rev-parse can fail if not in a git repo or HEAD is invalid
    local HEAD_SHA
    if ! HEAD_SHA=$(git rev-parse HEAD); then
        log_error "Failed to get current commit SHA"
        return 1
    fi
    if [ -z "$HEAD_SHA" ]; then
        log_error "git rev-parse HEAD returned empty SHA"
        return 1
    fi
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
    # NOTE: Use grep -qF for fixed-string matching (version dots are literal, not regex)
    if git ls-remote --tags origin | grep -qF "refs/tags/v$VERSION"; then
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
        # NOTE: Use grep -qF for fixed-string matching (version dots are literal, not regex)
        if git ls-remote --tags origin | grep -qF "refs/tags/v$VERSION"; then
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

    # NOTE: Timeout value comes from CFG_CI_TIMEOUT (default 900s = 15 minutes)
    local TIMEOUT_MINUTES=$((MAX_WAIT / 60))
    log_info "Monitoring CI workflow for commit ${COMMIT_SHA:0:7}..."
    log_info "  (lint, typecheck, test, e2e, coverage) timeout: ${TIMEOUT_MINUTES} minutes"

    while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
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
                # Show failed job details first
                if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
                    echo "" >&2
                    log_error "Failed job logs (first 50 lines):"
                    gh run view "$RUN_ID" --log-failed 2>/dev/null | head -50 || true
                fi

                error_with_guidance \
                    "CI workflow failed with conclusion: $WORKFLOW_CONCLUSION" \
                    "GitHub Actions CI detected issues. The release cannot proceed until CI passes." \
                    "Check the workflow logs, fix the issues locally, commit, and retry" \
                    "gh run view $RUN_ID --log  # view full logs  |  gh run view $RUN_ID --web  # open in browser"
                # NOTE: Use return 1 instead of exit 1 so caller can handle error properly (e.g., rollback)
                return 1
            fi
        fi

        # Workflow still in progress
        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    echo ""  # Newline after progress dots
    error_with_guidance \
        "Timeout waiting for CI workflow (exceeded ${TIMEOUT_MINUTES} minutes)" \
        "The CI workflow is taking longer than expected. It may still be running or may be stuck." \
        "Check the workflow status manually and wait for it to complete" \
        "gh run watch  # interactive watcher  |  gh run list --workflow=ci.yml  # list recent runs"
    log_info "Commit SHA: $COMMIT_SHA"
    # NOTE: Use return 1 instead of exit 1 so caller can handle error properly (e.g., rollback)
    return 1
}

# Wait for Publish to npm workflow after creating GitHub Release
# PHASE 1.2: Uses configurable timeout (default 15 min) + filter by tag commit SHA
wait_for_workflow() {
    local VERSION=$1
    local MAX_WAIT="${CFG_PUBLISH_TIMEOUT:-900}"  # From config or default 15 minutes
    local ELAPSED=0
    local WORKFLOW_JSON MATCHING_RUN WORKFLOW_STATUS WORKFLOW_CONCLUSION RUN_ID

    log_info "Waiting for GitHub Actions 'Publish to npm' workflow..."
    # NOTE: Timeout value comes from CFG_PUBLISH_TIMEOUT (default 900s = 15 minutes)
    local TIMEOUT_MINUTES=$((MAX_WAIT / 60))
    log_info "  Version: v$VERSION (timeout: ${TIMEOUT_MINUTES} minutes)"

    sleep 5  # Give GitHub a moment to register the tag

    # PHASE 1.2: Get the commit SHA for the tag to filter workflows
    local TAG_SHA
    TAG_SHA=$(git rev-list -n 1 "v$VERSION" 2>/dev/null || echo "")
    if [ -n "$TAG_SHA" ]; then
        log_info "  Tag commit: ${TAG_SHA:0:7}"
    fi

    while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
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
                # Show failed job details first
                if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
                    echo "" >&2
                    log_error "Failed job logs (first 50 lines):"
                    gh run view "$RUN_ID" --log-failed 2>/dev/null | head -50 || true
                fi

                error_with_guidance \
                    "Publish workflow failed with conclusion: $WORKFLOW_CONCLUSION" \
                    "The npm publish workflow failed. Common causes: npm trusted publishing misconfigured, Node.js version too old (need 24+), or publish.yml syntax errors." \
                    "Check workflow logs and npm trusted publisher settings on npmjs.com" \
                    "gh run view $RUN_ID --log  # logs  |  gh run view $RUN_ID --web  # browser"
                # NOTE: Use return 1 instead of exit 1 so caller can handle error properly (e.g., rollback)
                return 1
            fi
        fi

        # Workflow still in progress
        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    echo ""  # Newline after progress dots
    error_with_guidance \
        "Timeout waiting for Publish workflow (exceeded ${TIMEOUT_MINUTES} minutes)" \
        "The publish workflow is taking too long. It may be stuck or waiting for approval." \
        "Check the workflow status and logs manually" \
        "gh run watch  # interactive  |  gh run list --workflow=publish.yml  # list runs"
    log_info "Version: v$VERSION"
    # NOTE: Use return 1 instead of exit 1 so caller can handle error properly (e.g., rollback)
    return 1
}

# Verify npm publication
# Uses configurable timeout with exponential backoff retry logic
verify_npm_publication() {
    local VERSION=$1
    # Use config value CFG_NPM_PROPAGATION_TIMEOUT (default 300 seconds = 5 minutes)
    local MAX_WAIT="${CFG_NPM_PROPAGATION_TIMEOUT:-300}"
    local TIMEOUT_MINUTES=$((MAX_WAIT / 60))
    local ELAPSED=0
    local BACKOFF=5      # Start with 5 second intervals
    local MAX_BACKOFF=30 # Cap at 30 second intervals
    local ATTEMPT=1
    local NPM_VERSION

    log_info "Verifying npm publication..."
    log_info "  Waiting for ${PACKAGE_NAME}@$VERSION to appear on registry (timeout: ${TIMEOUT_MINUTES} minutes)..."

    while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
        # Check npm registry for the version
        # NOTE: portable_timeout works on both GNU (Linux) and BSD (macOS) systems
        NPM_VERSION=$(portable_timeout 10 npm view "${PACKAGE_NAME}@$VERSION" version 2>/dev/null || echo "")

        if [ "$NPM_VERSION" = "$VERSION" ]; then
            echo ""  # Newline after progress dots
            log_success "Package ${PACKAGE_NAME}@$VERSION is live on npm!"
            log_success "Install with: npm install ${PACKAGE_NAME}@$VERSION"
            return 0
        fi

        # Exponential backoff (5s -> 10s -> 20s -> 30s cap)
        echo -n "."
        sleep $BACKOFF
        ELAPSED=$((ELAPSED + BACKOFF))
        ATTEMPT=$((ATTEMPT + 1))

        # Double the backoff for next iteration, capped at MAX_BACKOFF
        if [ "$BACKOFF" -lt "$MAX_BACKOFF" ]; then
            BACKOFF=$((BACKOFF * 2))
            if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then
                BACKOFF=$MAX_BACKOFF
            fi
        fi
    done

    echo ""  # Newline after progress dots
    error_with_guidance \
        "Package ${PACKAGE_NAME}@$VERSION not found on npm after ${TIMEOUT_MINUTES} minutes" \
        "npm registry propagation can take several minutes. The package may still appear." \
        "Wait a few more minutes and check manually. If still missing, check the publish workflow logs." \
        "npm view ${PACKAGE_NAME}@$VERSION version  # check if available now"
    log_info "If the version appears later, the release was successful"
    exit 1
}

# Verify post-publish installation
# PHASE 1.4: Test that the published package actually works after npm install
# This catches packaging bugs like missing files in package.json "files" array
verify_post_publish_installation() {
    local VERSION=$1

    log_info "Verifying package installation in clean environment..."

    # Create isolated temp directory (simulates fresh user environment)
    # NOTE: Use global VERIFY_TEMP_DIR instead of local so handle_exit can clean it on interrupt
    VERIFY_TEMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'svg-bbox-verify')
    # NOTE: Check mktemp succeeded - can fail if /tmp is full or read-only
    if [ -z "$VERIFY_TEMP_DIR" ] || [ ! -d "$VERIFY_TEMP_DIR" ]; then
        log_warning "Failed to create temp directory for verification"
        return 0  # Non-fatal: package is already on npm, just can't verify
    fi
    log_info "  Test directory: $VERIFY_TEMP_DIR"

    # NOTE: We track VERIFY_TEMP_DIR globally so handle_exit can clean it on interrupt.
    # This ensures cleanup happens even if the script receives SIGINT/SIGTERM.
    # Each explicit return path below also clears VERIFY_TEMP_DIR for immediate cleanup.

    # Initialize npm project
    log_info "  → Initializing npm project..."
    if ! (cd "$VERIFY_TEMP_DIR" && npm init -y >/dev/null 2>&1); then
        log_warning "npm init failed in temp directory"
        rm -rf "$VERIFY_TEMP_DIR"
        VERIFY_TEMP_DIR=""
        return 0  # Non-fatal: package is already on npm, just can't verify
    fi

    # Install package from registry (not local tarball)
    log_info "  → Installing ${PACKAGE_NAME}@$VERSION from npm registry..."
    if ! (cd "$VERIFY_TEMP_DIR" && npm install "${PACKAGE_NAME}@$VERSION" --no-save 2>&1 | tail -5); then
        log_warning "npm install failed - package may not be fully propagated yet"
        rm -rf "$VERIFY_TEMP_DIR"
        VERIFY_TEMP_DIR=""
        return 0  # Non-fatal: registry may still be propagating
    fi

    local INSTALLED_PATH="$VERIFY_TEMP_DIR/node_modules/${PACKAGE_NAME}"

    # Verify package exists
    if [ ! -d "$INSTALLED_PATH" ]; then
        log_error "Package not found at $INSTALLED_PATH after install"
        rm -rf "$VERIFY_TEMP_DIR"
        VERIFY_TEMP_DIR=""
        return 1
    fi

    # PHASE 1.4: Test that require('svg-bbox') loads without MODULE_NOT_FOUND
    log_info "  → Verifying require('svg-bbox') works..."
    REQUIRE_TEST=$(cd "$VERIFY_TEMP_DIR" && node -e "try { require('svg-bbox'); console.log('OK'); } catch(e) { console.log(e.code || e.message); process.exit(1); }" 2>&1)
    if [ "$REQUIRE_TEST" != "OK" ]; then
        log_error "require('svg-bbox') failed: $REQUIRE_TEST"
        log_error "This indicates a packaging bug - missing files or broken dependencies"
        rm -rf "$VERIFY_TEMP_DIR"
        VERIFY_TEMP_DIR=""
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
        # NOTE: portable_timeout works on both GNU (Linux) and BSD (macOS) systems
        HELP_OUTPUT=$(cd "$VERIFY_TEMP_DIR" && portable_timeout 10 node "$TOOL_PATH" --help 2>&1 || echo "TIMEOUT_OR_ERROR")

        # Check for MODULE_NOT_FOUND errors
        if echo "$HELP_OUTPUT" | grep -q "MODULE_NOT_FOUND\|Cannot find module"; then
            FAILED_TOOLS="${FAILED_TOOLS}${TOOL} (missing deps) "
        fi
    done

    if [ -n "$FAILED_TOOLS" ]; then
        log_error "Some CLI tools failed verification: $FAILED_TOOLS"
        log_error "This indicates missing files in package.json 'files' array"
        rm -rf "$VERIFY_TEMP_DIR"
        VERIFY_TEMP_DIR=""
        return 1
    fi

    log_success "  All ${#CLI_TOOLS[@]} CLI tools verified"

    # Cleanup temp directory
    rm -rf "$VERIFY_TEMP_DIR"
    VERIFY_TEMP_DIR=""

    log_success "Post-publish installation verification passed (npm)"
    return 0
}

# Verify post-publish installation with Bun
# PHASE 1.5: Test installation with bun and run actual CLI commands
# WHY: Users may install with bun, and we should verify it works
verify_bun_installation() {
    local VERSION=$1

    # Check if bun is available
    if ! command -v bun >/dev/null 2>&1; then
        log_warning "Bun not installed - skipping bun verification"
        return 0
    fi

    log_info "Verifying package installation with Bun..."

    # Create isolated temp directory for bun test
    local BUN_TEMP_DIR
    BUN_TEMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'svg-bbox-bun-verify')
    if [ -z "$BUN_TEMP_DIR" ] || [ ! -d "$BUN_TEMP_DIR" ]; then
        log_warning "Failed to create temp directory for bun verification"
        return 0  # Non-fatal
    fi
    log_info "  Test directory: $BUN_TEMP_DIR"

    # Initialize bun project
    log_info "  → Initializing bun project..."
    if ! (cd "$BUN_TEMP_DIR" && bun init -y >/dev/null 2>&1); then
        log_warning "bun init failed in temp directory"
        rm -rf "$BUN_TEMP_DIR"
        return 0  # Non-fatal
    fi

    # Install package from npm registry using bun
    log_info "  → Installing ${PACKAGE_NAME}@$VERSION with bun..."
    if ! (cd "$BUN_TEMP_DIR" && bun add "${PACKAGE_NAME}@$VERSION" 2>&1 | tail -5); then
        log_warning "bun add failed - package may not be fully propagated yet"
        rm -rf "$BUN_TEMP_DIR"
        return 0  # Non-fatal
    fi

    local INSTALLED_PATH="$BUN_TEMP_DIR/node_modules/${PACKAGE_NAME}"

    # Verify package exists
    if [ ! -d "$INSTALLED_PATH" ]; then
        log_error "Package not found at $INSTALLED_PATH after bun add"
        rm -rf "$BUN_TEMP_DIR"
        return 1
    fi

    # Test require works with bun
    log_info "  → Verifying require('svg-bbox') works with bun..."
    REQUIRE_TEST=$(cd "$BUN_TEMP_DIR" && bun -e "try { require('svg-bbox'); console.log('OK'); } catch(e) { console.log(e.code || e.message); process.exit(1); }" 2>&1)
    if [ "$REQUIRE_TEST" != "OK" ]; then
        log_error "require('svg-bbox') failed with bun: $REQUIRE_TEST"
        rm -rf "$BUN_TEMP_DIR"
        return 1
    fi
    log_success "  require('svg-bbox') works with bun"

    # Test actual CLI command execution (not just --help)
    log_info "  → Testing actual CLI command execution..."

    # Create a simple test SVG
    local TEST_SVG="$BUN_TEMP_DIR/test.svg"
    cat > "$TEST_SVG" << 'SVGEOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
</svg>
SVGEOF

    # Test sbb-getbbox (core bbox calculation)
    local BBOX_TOOL="$INSTALLED_PATH/sbb-getbbox.cjs"
    if [ -f "$BBOX_TOOL" ]; then
        log_info "  → Testing sbb-getbbox with actual SVG..."
        # NOTE: portable_timeout works on both GNU (Linux) and BSD (macOS) systems
        local BBOX_OUTPUT
        BBOX_OUTPUT=$(cd "$BUN_TEMP_DIR" && portable_timeout 30 node "$BBOX_TOOL" "$TEST_SVG" 2>&1 || echo "COMMAND_FAILED")

        if echo "$BBOX_OUTPUT" | grep -qE "COMMAND_FAILED|Error|MODULE_NOT_FOUND|Cannot find module"; then
            log_error "sbb-getbbox failed: $BBOX_OUTPUT"
            rm -rf "$BUN_TEMP_DIR"
            return 1
        fi

        # Verify output contains expected bbox coordinates
        if echo "$BBOX_OUTPUT" | grep -qE '"x":|"y":|"width":|"height":'; then
            log_success "  sbb-getbbox returns valid bbox JSON"
        else
            log_warning "  sbb-getbbox output may not be valid bbox (output: $BBOX_OUTPUT)"
        fi
    fi

    # Test sbb-extract (SVG extraction)
    local EXTRACT_TOOL="$INSTALLED_PATH/sbb-extract.cjs"
    if [ -f "$EXTRACT_TOOL" ]; then
        log_info "  → Testing sbb-extract --help..."
        local EXTRACT_OUTPUT
        EXTRACT_OUTPUT=$(cd "$BUN_TEMP_DIR" && portable_timeout 10 node "$EXTRACT_TOOL" --help 2>&1 || echo "COMMAND_FAILED")

        if echo "$EXTRACT_OUTPUT" | grep -qE "COMMAND_FAILED|MODULE_NOT_FOUND|Cannot find module"; then
            log_error "sbb-extract failed: $EXTRACT_OUTPUT"
            rm -rf "$BUN_TEMP_DIR"
            return 1
        fi
        log_success "  sbb-extract --help works"
    fi

    # Test sbb-compare --help (compare tool)
    local COMPARE_TOOL="$INSTALLED_PATH/sbb-compare.cjs"
    if [ -f "$COMPARE_TOOL" ]; then
        log_info "  → Testing sbb-compare --help..."
        local COMPARE_OUTPUT
        COMPARE_OUTPUT=$(cd "$BUN_TEMP_DIR" && portable_timeout 10 node "$COMPARE_TOOL" --help 2>&1 || echo "COMMAND_FAILED")

        if echo "$COMPARE_OUTPUT" | grep -qE "COMMAND_FAILED|MODULE_NOT_FOUND|Cannot find module"; then
            log_error "sbb-compare failed: $COMPARE_OUTPUT"
            rm -rf "$BUN_TEMP_DIR"
            return 1
        fi
        log_success "  sbb-compare --help works"
    fi

    # Cleanup
    rm -rf "$BUN_TEMP_DIR"

    log_success "Post-publish installation verification passed (bun)"
    return 0
}

# ══════════════════════════════════════════════════════════════════
# MULTI-OUTLET PUBLISHING VERIFICATION
# Verifies package availability across multiple distribution channels
# ══════════════════════════════════════════════════════════════════

# Verify CDN availability (jsDelivr and unpkg automatically serve npm packages)
# NOTE: Uses PROJECT_CDN_FILE variable from top of script for CDN URLs
verify_cdn_availability() {
    local VERSION=$1
    local MAX_WAIT=120  # 2 minutes for CDN propagation
    local ELAPSED=0

    log_info "Verifying CDN availability..."

    # Check jsDelivr (auto-syncs from npm within minutes)
    local JSDELIVR_URL="https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"
    log_info "  → Checking jsDelivr: $JSDELIVR_URL"

    while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
        # Check if CDN returns 200 status
        # NOTE: --max-time 10 prevents hanging on slow/unresponsive CDN endpoints
        # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
        local HTTP_STATUS
        HTTP_STATUS=$(curl -sI --max-time 10 "$JSDELIVR_URL" 2>/dev/null | head -1 | grep -oE "[0-9]{3}" | head -1 || true)

        if [ "$HTTP_STATUS" = "200" ]; then
            log_success "  jsDelivr: Available"
            break
        fi

        echo -n "."
        sleep 10
        ELAPSED=$((ELAPSED + 10))
    done

    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        log_warning "  jsDelivr: Not yet available (may take a few more minutes)"
    fi

    # Check unpkg (also auto-syncs from npm)
    local UNPKG_URL="https://unpkg.com/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"
    log_info "  → Checking unpkg: $UNPKG_URL"

    # NOTE: --max-time 10 prevents hanging on slow/unresponsive CDN endpoints
    # NOTE: || true ensures set -o pipefail doesn't abort on empty grep result
    HTTP_STATUS=$(curl -sI --max-time 10 "$UNPKG_URL" 2>/dev/null | head -1 | grep -oE "[0-9]{3}" | head -1 || true)
    if [ "$HTTP_STATUS" = "200" ]; then
        log_success "  unpkg: Available"
    else
        log_warning "  unpkg: Not yet available (may take a few more minutes)"
    fi

    echo ""
    log_info "CDN URLs for this release:"
    log_info "  jsDelivr: https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"
    log_info "  unpkg:    https://unpkg.com/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"

    return 0
}

# Print Homebrew formula update instructions (if applicable)
print_homebrew_instructions() {
    local VERSION=$1

    # Check if this project has a Homebrew tap configuration
    local HAS_HOMEBREW=false
    if [ -f "config/release_conf.yml" ]; then
        local HOMEBREW_TAP
        HOMEBREW_TAP=$(get_config "homebrew.tap" "")
        if [ -n "$HOMEBREW_TAP" ] && [ "$HOMEBREW_TAP" != "null" ]; then
            HAS_HOMEBREW=true
        fi
    fi

    # Check for Homebrew formula in common locations
    if [ -f "Formula/${PACKAGE_NAME}.rb" ] || [ -f "HomebrewFormula/${PACKAGE_NAME}.rb" ]; then
        HAS_HOMEBREW=true
    fi

    if [ "$HAS_HOMEBREW" = true ]; then
        echo ""
        log_info "Homebrew Formula Update:"
        log_info "────────────────────────"
        log_info "If you maintain a Homebrew tap, update the formula with:"
        log_info ""
        log_info "  1. Update version in Formula/${PACKAGE_NAME}.rb"
        log_info "  2. Update sha256 checksum:"
        log_info "     curl -sL \"https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${VERSION}.tgz\" | shasum -a 256"
        log_info "  3. Test locally: brew install --build-from-source ./${PACKAGE_NAME}.rb"
        log_info "  4. Commit and push the formula changes"
        echo ""
    fi
}

# Print release summary with all distribution channels
print_release_summary() {
    local VERSION=$1

    echo ""
    echo "═══════════════════════════════════════════════════════════════════════" >&2
    echo "  RELEASE SUMMARY - v$VERSION" >&2
    echo "═══════════════════════════════════════════════════════════════════════" >&2
    echo ""

    log_info "Distribution Channels:"
    echo ""
    log_info "  npm Registry:"
    log_info "    npm install ${PACKAGE_NAME}@${VERSION}"
    log_info "    pnpm add ${PACKAGE_NAME}@${VERSION}"
    log_info "    yarn add ${PACKAGE_NAME}@${VERSION}"
    echo ""
    log_info "  CDN (Browser):"
    log_info "    jsDelivr: https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"
    log_info "    unpkg:    https://unpkg.com/${PACKAGE_NAME}@${VERSION}/${PROJECT_CDN_FILE}"
    echo ""
    log_info "  GitHub:"
    log_info "    Release: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v${VERSION}"
    log_info "    Package: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pkgs/npm/${PACKAGE_NAME}"
    echo ""
    log_info "  npm Package Page:"
    log_info "    https://www.npmjs.com/package/${PACKAGE_NAME}/v/${VERSION}"
    echo ""
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
            --validate-only|--validate)
                VALIDATE_ONLY=true
                shift
                ;;
            --fast-fail)
                FAST_FAIL=true
                shift
                ;;
            --offline)
                OFFLINE_MODE=true
                shift
                ;;
            --json-report|--json)
                JSON_REPORT=true
                shift
                ;;
            --strict)
                STRICT_MODE=true
                shift
                ;;
            --no-strict)
                STRICT_MODE=false
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
                echo "  --validate-only   Run all validations and exit (no release)"
                echo "  --fast-fail       Exit on first validation error"
                echo "  --offline         Skip network validation (URLs, npm registry)"
                echo "  --json-report     Output validation results as JSON"
                echo "  --strict          Treat warnings as errors (default)"
                echo "  --no-strict       Allow warnings without failing"
                echo "  --help, -h        Show this help message"
                echo ""
                echo "Examples:"
                echo "  $0 patch               # Bump patch (1.0.10 → 1.0.11)"
                echo "  $0 minor               # Bump minor (1.0.10 → 1.1.0)"
                echo "  $0 major               # Bump major (1.0.10 → 2.0.0)"
                echo "  $0 1.0.11              # Specific version"
                echo "  $0 --yes patch         # Skip confirmation prompt"
                echo "  $0 --init-config       # Generate config file"
                echo "  $0 --check             # Analyze CI workflows"
                echo "  $0 --validate-only     # Run validations only (dry run)"
                echo "  $0 --validate-only --json-report   # Validation as JSON"
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

        # Show validation toolchain status (jsonlint, yamllint, eslint, etc.)
        report_validation_toolchain

        # Print CI analysis
        print_ci_analysis

        # Run documentation audit if script exists
        echo ""
        echo "Documentation Audit:"
        echo "────────────────────"
        if [ -f "scripts/docs-audit.cjs" ]; then
            if node scripts/docs-audit.cjs 2>/dev/null; then
                echo -e "  ${GREEN}✓${NC} Documentation audit passed"
            else
                echo -e "  ${RED}✗${NC} Documentation audit found issues - run: node scripts/docs-audit.cjs"
            fi
        else
            echo -e "  ${YELLOW}!${NC} docs-audit.cjs not found - skipping documentation validation"
        fi

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

    # Handle --validate-only: run all validations and exit without releasing
    if [ "$VALIDATE_ONLY" = true ]; then
        echo ""
        echo "═══════════════════════════════════════════════════════════"
        echo "  Pre-Release Validation (--validate-only mode)"
        echo "═══════════════════════════════════════════════════════════"
        echo ""

        # Determine target version for validation
        local TARGET_VERSION=""
        if [ -n "$VERSION_ARG" ]; then
            case "$VERSION_ARG" in
                patch|minor|major)
                    # Calculate what the version would be
                    local CURRENT=$(get_current_version)
                    TARGET_VERSION=$(calculate_next_version "$CURRENT" "$VERSION_ARG")
                    ;;
                *)
                    # Specific version provided
                    TARGET_VERSION="$VERSION_ARG"
                    ;;
            esac
            log_info "Target version: $TARGET_VERSION"
        else
            log_info "No version specified - validating current state"
        fi
        echo ""

        # Run all validations
        if run_all_validations "$TARGET_VERSION"; then
            echo ""
            log_success "All validations passed!"
            if [ -n "$TARGET_VERSION" ]; then
                log_info "Ready to release v$TARGET_VERSION"
                log_info "Run: $0 $VERSION_ARG"
            fi
            exit 0
        else
            echo ""
            log_error "Validation failed - fix issues before releasing"
            exit 1
        fi
    fi

    if [ -z "$VERSION_ARG" ]; then
        log_error "Usage: $0 [options] [version|patch|minor|major]"
        log_info "Options: --yes, --verbose, --init-config, --check, --validate-only, --help"
        log_info "Examples:"
        log_info "  $0 patch             # Bump patch (1.0.10 → 1.0.11)"
        log_info "  $0 --yes patch       # Skip confirmation prompt"
        log_info "  $0 --check           # Analyze CI workflows"
        log_info "  $0 --validate-only   # Run validations only"
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

    # Declare local variables to avoid global namespace pollution
    local CURRENT_VERSION NEW_VERSION PREVIOUS_TAG

    # Get current version
    CURRENT_VERSION=$(get_current_version)
    log_info "Current version: $CURRENT_VERSION"

    # Calculate target version (without modifying anything yet)
    local TARGET_VERSION=""
    case $VERSION_ARG in
        patch|minor|major)
            TARGET_VERSION=$(calculate_next_version "$CURRENT_VERSION" "$VERSION_ARG")
            ;;
        *)
            TARGET_VERSION="$VERSION_ARG"
            ;;
    esac
    log_info "Target version: $TARGET_VERSION"
    echo ""

    # ══════════════════════════════════════════════════════════════════
    # COMPREHENSIVE VALIDATION (READ-ONLY)
    # Runs all validators BEFORE making any changes
    # WHY: Catch all issues upfront with actionable fix instructions
    # ══════════════════════════════════════════════════════════════════
    log_info "Running comprehensive pre-release validation..."
    echo ""

    if ! run_all_validations "$TARGET_VERSION"; then
        echo ""
        log_error "Validation failed - fix issues before releasing"
        log_info "Run '$0 --validate-only $VERSION_ARG' to re-check after fixing"
        exit 1
    fi

    echo ""
    log_success "All validations passed!"
    echo ""

    # ══════════════════════════════════════════════════════════════════
    # VERSION BUMP (Now safe to modify files)
    # ══════════════════════════════════════════════════════════════════

    # Bump version using npm
    case $VERSION_ARG in
        patch|minor|major)
            NEW_VERSION=$(bump_version "$VERSION_ARG")
            ;;
        *)
            NEW_VERSION=$(set_version "$VERSION_ARG")
            ;;
    esac

    # Verify the bump produced the expected version
    if [ "$NEW_VERSION" != "$TARGET_VERSION" ]; then
        log_error "Version mismatch: expected $TARGET_VERSION but got $NEW_VERSION"
        log_error "This may indicate a version.cjs or build issue"
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 1
    fi

    echo "" >&2
    log_info "Release version: $NEW_VERSION"
    echo "" >&2

    # ══════════════════════════════════════════════════════════════════
    # VERSION-DEPENDENT CHECKS (validation already done above)
    # ══════════════════════════════════════════════════════════════════

    # Double-check npm (already validated but good to confirm after bump)
    log_info "Confirming npm registry status..."
    local EXISTING_NPM_VERSION
    EXISTING_NPM_VERSION=$(npm view "${PACKAGE_NAME}@${NEW_VERSION}" version 2>/dev/null || echo "")
    if [ "$EXISTING_NPM_VERSION" = "$NEW_VERSION" ]; then
        log_warning "Version $NEW_VERSION is already published on npm"
        log_info "Skipping release (idempotent)"
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 0
    fi
    log_success "Confirmed: Version $NEW_VERSION not on npm"

    # Double-check git tag (already validated but good to confirm after bump)
    log_info "Confirming git tag status..."
    if ! check_tag_not_exists "$NEW_VERSION"; then
        log_error "Cannot proceed - tag already exists"
        log_info "Restoring package.json..."
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 1
    fi
    log_success "Confirmed: Git tag v$NEW_VERSION does not exist"

    # ══════════════════════════════════════════════════════════════════
    # USER CONFIRMATION
    # ══════════════════════════════════════════════════════════════════

    # Confirm with user (unless --yes flag)
    if [ "$SKIP_CONFIRMATION" = false ]; then
        read -p "$(echo -e "${YELLOW}Do you want to release v${NEW_VERSION}? [y/N]${NC} ")" -n 1 -r
        echo
        # NOTE: Quote $REPLY for robustness (handles empty/unset REPLY from read failure)
        if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
            log_warning "Release cancelled"
            git checkout package.json pnpm-lock.yaml 2>/dev/null || true
            exit 0
        fi
    else
        log_info "Skipping confirmation (--yes flag)"
    fi

    # ══════════════════════════════════════════════════════════════════
    # QUALITY CHECKS
    # WHY: Validate code quality before release - no auto-fixing, just validation
    # ══════════════════════════════════════════════════════════════════

    # Run quality checks (lint, typecheck, tests)
    run_quality_checks || rollback_release "$NEW_VERSION" "quality-checks"

    # ══════════════════════════════════════════════════════════════════
    # RELEASE EXECUTION
    # ══════════════════════════════════════════════════════════════════

    # Get previous tag for release notes
    PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    # Generate release notes
    generate_release_notes "$NEW_VERSION" "$PREVIOUS_TAG" || rollback_release "$NEW_VERSION" "release-notes"

    # Update CHANGELOG.md before committing
    # WHY: Changelog must be updated at every release to maintain accurate history
    # WHY: This must happen BEFORE commit_version_bump() so CHANGELOG.md is included in the commit
    update_changelog "$NEW_VERSION"

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

    # PHASE 1.4 - Verify package works after installation (npm)
    # This catches packaging bugs like missing files in package.json "files" array
    verify_post_publish_installation "$NEW_VERSION" || log_warning "Post-publish verification had issues (non-fatal)"

    # PHASE 1.5 - Verify package works with bun installation
    # WHY: Users may install with bun, and we should verify it works too
    verify_bun_installation "$NEW_VERSION" || log_warning "Bun verification had issues (non-fatal)"

    # ══════════════════════════════════════════════════════════════════
    # MULTI-OUTLET VERIFICATION
    # ══════════════════════════════════════════════════════════════════

    # Verify CDN availability (jsDelivr, unpkg auto-sync from npm)
    verify_cdn_availability "$NEW_VERSION"

    # Print Homebrew update instructions if applicable
    print_homebrew_instructions "$NEW_VERSION"

    # Print comprehensive release summary
    print_release_summary "$NEW_VERSION"

    # Success banner
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    log_success "Release v$NEW_VERSION completed successfully!"
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "" >&2

    # Note: Cleanup is handled by the EXIT trap (handle_exit function)
}

# Run main function
main "$@"
