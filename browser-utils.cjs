/**
 * browser-utils.cjs
 *
 * Utilities for opening files in Chrome/Chromium browsers ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY CHROME/CHROMIUM ONLY?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Other browsers have poor SVG support and produce incorrect results.
 *
 * This library uses headless Chrome via Puppeteer for SVG measurement.
 * Visual verification MUST use the same browser engine to match results.
 *
 * ONLY Chrome or Chromium are acceptable.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFilePromise = promisify(execFile);

/**
 * Detect available Chrome/Chromium browsers on the system
 * @returns {Promise<{found: boolean, path: string|null, name: string|null}>}
 */
async function detectChrome() {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: try common Chrome/Chromium locations
    const candidates = [
      { path: '/Applications/Google Chrome.app', name: 'Google Chrome' },
      { path: '/Applications/Chromium.app', name: 'Chromium' },
      { path: '/Applications/Google Chrome Canary.app', name: 'Google Chrome Canary' }
    ];

    for (const candidate of candidates) {
      try {
        // Check if application exists using ls
        await execFilePromise('ls', [candidate.path]);
        return { found: true, path: candidate.path, name: candidate.name };
      } catch {
        // App not found, try next
      }
    }
  } else if (platform === 'win32') {
    // Windows: try common Chrome install locations
    const candidates = [
      { cmd: 'chrome.exe', name: 'Google Chrome' },
      { cmd: 'chromium.exe', name: 'Chromium' }
    ];

    for (const candidate of candidates) {
      try {
        await execFilePromise('where', [candidate.cmd]);
        return { found: true, path: candidate.cmd, name: candidate.name };
      } catch {
        // Not found, try next
      }
    }
  } else {
    // Linux: try common Chrome/Chromium commands
    const candidates = [
      { cmd: 'google-chrome', name: 'Google Chrome' },
      { cmd: 'google-chrome-stable', name: 'Google Chrome' },
      { cmd: 'chromium', name: 'Chromium' },
      { cmd: 'chromium-browser', name: 'Chromium' }
    ];

    for (const candidate of candidates) {
      try {
        await execFilePromise('which', [candidate.cmd]);
        return { found: true, path: candidate.cmd, name: candidate.name };
      } catch {
        // Not found, try next
      }
    }
  }

  return { found: false, path: null, name: null };
}

/**
 * Open a file in Chrome/Chromium browser
 * @param {string} filePath - Absolute path to file to open
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function openInChrome(filePath) {
  const detection = await detectChrome();

  if (!detection.found) {
    const installMsg = getInstallInstructions();
    return {
      success: false,
      error: `Chrome/Chromium not found.\n\n${installMsg}`
    };
  }

  const platform = process.platform;
  let command, args;

  try {
    if (platform === 'darwin') {
      command = 'open';
      args = ['-a', detection.name, filePath];
    } else if (platform === 'win32') {
      // Windows: Use 'start ""' to handle paths with spaces
      // The empty quotes are the window title (required before the path)
      command = 'cmd';
      args = ['/c', 'start', '""', detection.path, filePath];
    } else {
      // Linux
      command = detection.path;
      args = [filePath];
    }

    await execFilePromise(command, args);
    return { success: true, error: null };
  } catch (error) {
    return {
      success: false,
      error: `Failed to open ${detection.name}: ${error.message}`
    };
  }
}

/**
 * Get platform-specific installation instructions for Chrome
 * @returns {string}
 */
function getInstallInstructions() {
  const platform = process.platform;

  if (platform === 'darwin') {
    return `Please install Google Chrome or Chromium:

macOS:
  • Download from: https://www.google.com/chrome/
  • Or install via Homebrew:
    brew install --cask google-chrome
    brew install --cask chromium

CRITICAL: Other browsers have poor SVG support.
ONLY Chrome/Chromium browsers are acceptable for SVG work.`;
  } else if (platform === 'win32') {
    return `Please install Google Chrome or Chromium:

Windows:
  • Download from: https://www.google.com/chrome/
  • Or install via Chocolatey:
    choco install googlechrome
    choco install chromium

CRITICAL: Other browsers have poor SVG support.
ONLY Chrome/Chromium browsers are acceptable.`;
  } else {
    return `Please install Google Chrome or Chromium:

Linux:
  • Debian/Ubuntu:
    sudo apt install google-chrome-stable
    sudo apt install chromium-browser

  • Fedora/RHEL:
    sudo dnf install google-chrome-stable
    sudo dnf install chromium

  • Arch:
    sudo pacman -S google-chrome
    sudo pacman -S chromium

CRITICAL: Other browsers have poor SVG support.
ONLY Chrome/Chromium browsers are acceptable.`;
  }
}

module.exports = {
  detectChrome,
  openInChrome,
  getInstallInstructions
};
