# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

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
- We will credit you in the security advisory (unless you prefer to remain anonymous)
- We will publish a security advisory on GitHub

## Security Considerations

### SVG Input

SVG files can contain malicious content. SVG-BBOX processes SVG files in headless Chrome, which provides some isolation but does not guarantee complete safety.

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

SVG files can reference external resources (images, fonts, stylesheets). This can lead to:

- **SSRF (Server-Side Request Forgery)** - SVG requests internal network resources
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

We use Puppeteer to launch headless Chrome, which has its own security considerations.

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
   if (stats.size > 10 * 1024 * 1024) { // 10 MB limit
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
   page.on('request', request => {
     const url = new URL(request.url());
     if (url.hostname !== 'localhost') {
       request.abort();
     } else {
       request.continue();
     }
   });
   ```

## Known Limitations

- **No SVG sanitization** - We do not sanitize SVG input
- **No network isolation** - External resources can be loaded by default
- **No resource limits** - Very large/complex SVG can consume excessive resources
- **Browser security** - We rely on Chrome's security, which is not perfect

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
