# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue,
please report it responsibly.

### How to Report

**DO NOT** open a public GitHub issue for security vulnerabilities.

Instead:

1. **Email** the maintainers directly (see package.json for contact info)
2. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. Wait for acknowledgment (typically within 48 hours)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity
  - Critical: Within days
  - High: Within 1-2 weeks
  - Medium: Within 4 weeks
  - Low: Next release cycle

### Disclosure Policy

- We will notify you when we have a fix ready
- We will coordinate disclosure timing with you
- We will credit you in the security advisory (unless you prefer to remain
  anonymous)
- We will publish a security advisory on GitHub

## Security Considerations

### SVG Input

SVG files can contain malicious content. SVG-BBOX processes SVG files in
headless Chrome, which provides some isolation but does not guarantee complete
safety.

**Risks:**

- **XXE (XML External Entity)** attacks via malicious SVG
- **XSS (Cross-Site Scripting)** via embedded scripts in SVG
- **Resource exhaustion** via extremely large or complex SVG
- **File system access** via `<image>` or `<use>` elements with file:// URLs

**Mitigations:**

- Run in headless browser (isolated environment)
- Disable JavaScript in browser context (when possible)
- Validate SVG files before processing
- Set timeouts on all operations
- Run in sandboxed environment (Docker, VM) for untrusted input

### External Resources

SVG files can reference external resources (images, fonts, stylesheets). This
can lead to:

- **SSRF (Server-Side Request Forgery)** - SVG requests internal network
  resources
- **Data exfiltration** - SVG sends data to external servers
- **Canvas tainting** - External resources without CORS headers

**Mitigations:**

- Block external network requests when processing untrusted SVG
- Use Content Security Policy (CSP) in browser context
- Validate and sanitize external resource URLs
- Run in network-isolated environment for untrusted input

### Dependency Security

We regularly update dependencies to address known vulnerabilities.

**What we do:**

- Monitor security advisories for dependencies
- Run `pnpm audit` regularly
- Update dependencies promptly
- Use tools like Dependabot for automated updates

**What you can do:**

- Keep your installation up to date
- Run `pnpm audit` to check for known vulnerabilities
- Report dependency vulnerabilities you discover

### CLI Tools

The CLI tools execute in your local environment with your permissions.

**Risks:**

- **Path traversal** - Malicious file paths could access unintended files
- **Command injection** - User input could be interpreted as shell commands
- **File overwrite** - Output paths could overwrite important files

**Mitigations:**

- Validate and sanitize all file paths
- Use absolute paths internally
- Never execute user input as shell commands
- Confirm before overwriting existing files (where applicable)
- Use Node.js built-in path utilities (path.join, path.resolve)

### Browser Launch

We use Puppeteer to launch headless Chrome, which has its own security
considerations.

**Risks:**

- **Browser vulnerabilities** - Outdated Chrome/Chromium versions
- **Sandbox escapes** - Malicious SVG could exploit browser bugs

**Mitigations:**

- Use latest Puppeteer (bundles recent Chrome)
- Run with sandbox enabled (default)
- Set resource limits (memory, CPU time)
- Use `--no-sandbox` only when absolutely necessary (CI environments)

### Recommended Security Practices

When using SVG-BBOX in production:

1. **Validate input**

   ```javascript
   // Check file size before processing
   const stats = fs.statSync(svgPath);
   if (stats.size > 10 * 1024 * 1024) {
     // 10 MB limit
     throw new Error('SVG file too large');
   }
   ```

2. **Set timeouts**

   ```javascript
   // Prevent infinite loops/hangs
   const timeout = 30000; // 30 seconds
   // Use timeout options in all operations
   ```

3. **Sanitize SVG** (if processing untrusted input)

   ```javascript
   // Use a library like DOMPurify or sanitize-html
   const sanitizedSvg = DOMPurify.sanitize(svgContent, {
     USE_PROFILES: { svg: true }
   });
   ```

4. **Run in isolated environment**

   ```bash
   # Use Docker for untrusted SVG processing
   docker run --rm -v ./input:/input:ro -v ./output:/output \
     svg-bbox sbb-getbbox /input/untrusted.svg
   ```

5. **Block external network**
   ```javascript
   // In Puppeteer, intercept and block external requests
   await page.setRequestInterception(true);
   page.on('request', (request) => {
     const url = new URL(request.url());
     if (url.hostname !== 'localhost') {
       request.abort();
     } else {
       request.continue();
     }
   });
   ```

## Security Audit Status

**Comprehensive Audit Performed:** 2025-11-24

### Issues Identified

| Severity  | Count  | Status         |
| --------- | ------ | -------------- |
| Critical  | 8      | ⏳ In Progress |
| High      | 14     | ⏳ In Progress |
| Medium    | 18     | 📋 Planned     |
| Low       | 7      | 📋 Planned     |
| **Total** | **47** |                |

See `docs_dev/security-audit-2025-11-24.md` (if available) for complete details.

### Critical Issues Being Addressed

1. **Command Injection** - Unsanitized file paths passed to shell commands
2. **Path Traversal** - Missing validation allows arbitrary file read/write
3. **SVG Code Injection** - Malicious SVG can execute code
4. **JSON Injection** - Prototype pollution via malicious JSON
5. **Insecure Temp Files** - Predictable paths in world-readable locations
6. **Undefined Variable Bug** - Critical parsing error in sbb-fix-viewbox
7. **Missing File Extension Validation** - Any file type accepted
8. **Windows Command Injection** - Unsafe path escaping on Windows

### Mitigation Progress

✅ **Completed:**

- Created `lib/security-utils.cjs` with comprehensive security functions
- Created `lib/cli-utils.cjs` for standardized CLI tooling
- Path validation (`validateFilePath`, `validateOutputPath`)
- SVG sanitization (`readSVGFileSafe`, `sanitizeSVGContent`)
  - Fixed event handler removal regex (changed `\son\w+` to `\s+on\w+`)
- JSON validation (`readJSONFileSafe`, `validateRenameMapping`)
- Secure temp file handling (`createSecureTempDir`)
- Custom error classes for better error handling
- **sbb-getbbox.cjs**: All 20 security fixes applied and tested
  - Path traversal protection ✅
  - Command injection protection ✅
  - SVG sanitization ✅
  - File extension validation ✅
  - Resource cleanup ✅
  - Timeout handling ✅

⏳ **In Progress:**

- Applying security fixes to remaining 2 CLI tools:
  - sbb-comparer.cjs (1399 lines) - 0% complete
  - sbb-extractor.cjs (2255 lines, 4 modes) - 0% complete

✅ **CLI Tools Completed (4/6):**

1. **sbb-getbbox.cjs** (807 → 755 lines) - All 20 security fixes applied ✅
2. **sbb-fix-viewbox.cjs** (298 → 362 lines) - All 20 fixes + undefined variable
   bug fixed ✅
3. **sbb-svg2png.cjs** (610 → 671 lines) - All 20 fixes + PNG output validation
   ✅
4. **sbb-test.cjs** (364 → 411 lines) - All 20 fixes + JSON/log output
   validation ✅

📋 **Planned:**

- Complete remaining 2 CLI tools (est. 10-12 hours)
- Adding comprehensive security tests (est. 5-7 hours)
- Updating all tool documentation (est. 3-5 hours)
- Refactoring duplicate code across CLI tools
- Breaking up large functions (>100 lines)
- Adding comprehensive JSDoc

**Current Status:** 4/6 CLI tools secured (66.7% complete) **Estimated
Completion:** 18-24 hours remaining total

## Known Limitations

- **Limited SVG sanitization** - Basic script/event removal (use DOMPurify for
  full sanitization)
- **No network isolation by default** - External resources can be loaded
- **No built-in resource limits** - Large/complex SVG can consume excessive
  resources
- **Browser security dependency** - Relies on Chromium's security model

## Security Checklist for Contributors

When contributing code:

- [ ] Validate all user input (file paths, options, arguments)
- [ ] Use parameterized queries/commands (no string concatenation)
- [ ] Set timeouts on all async operations
- [ ] Handle errors explicitly (no silent failures)
- [ ] Sanitize output (especially HTML generation)
- [ ] Document security considerations in PR
- [ ] Check dependencies for known vulnerabilities (`pnpm audit`)
- [ ] Add tests for security-critical code

## Security Tools

We use:

- **pnpm audit** - Check for vulnerable dependencies
- **ESLint** - Static analysis for common security issues
- **Dependabot** - Automated dependency updates

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [SVG Security](https://www.w3.org/TR/SVG2/security.html)
- [Puppeteer Security](https://pptr.dev/#security)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

## Contact

For security issues: See package.json for maintainer contact information

For general questions: Open a GitHub discussion (NOT an issue)

Thank you for helping keep SVG-BBOX secure! 🔒
