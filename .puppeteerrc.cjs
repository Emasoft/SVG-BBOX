/**
 * Puppeteer configuration
 * Skip browser download during npm/bun install - download lazily on first use
 */
module.exports = {
  // Skip download during package installation
  // Browser will be downloaded on first use by our CLI tools
  skipDownload: true
};
