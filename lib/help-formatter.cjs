/**
 * Unified help-screen formatter for all svg-bbox CLI tools.
 *
 * Why a dedicated module: every CLI tool needs the same shape — branded
 * header box with version, description, usage, basic-vs-advanced options
 * split, examples, batch-mode spec, FBF.SVG spec, environment variables,
 * and a "see also" footer. Re-implementing that in 13 places drifted into
 * 13 different formats. This module is the single source of truth.
 *
 * @module help-formatter
 */

const { getVersion } = require('../version.cjs');

// ============================================================================
// Constants
// ============================================================================

const REPO_URL = 'https://github.com/Emasoft/SVG-BBOX';
const PARENT_PACKAGE = 'svg-bbox';
const SISTER_PROJECT_FBF = 'https://github.com/Emasoft/svg2fbf';
const ISSUES_URL = `${REPO_URL}/issues`;
const README_URL = `${REPO_URL}#readme`;

// Box-drawing characters (Unicode, double-line for the outer header).
const BOX = {
  topLeft: '╔',
  topRight: '╗',
  bottomLeft: '╚',
  bottomRight: '╝',
  horizontal: '═',
  vertical: '║'
};

const SECTION_RULE = '─';
const HEADER_INNER_PAD = 2; // Spaces between vertical rule and content.
const HEADER_TOTAL_WIDTH = 78; // Outer width including the box edges.

/** @type {Array<[string, string]>} */
const COMMON_ENV_VARS = [
  ['SVG_BBOX_BROWSER_PATH', 'Absolute path to a Chrome/Chromium executable.'],
  [
    'SVG_BBOX_SKIP_BROWSER_DOWNLOAD',
    'Set to "1" to skip Puppeteer auto-download (use system Chrome).'
  ],
  ['PUPPETEER_EXECUTABLE_PATH', 'Native Puppeteer override for the browser path.']
];

/** @type {Array<[string, string]>} */
const INKSCAPE_ENV_VARS = [
  ['SBB_INKSCAPE_PATH', 'Absolute path to the Inkscape executable.'],
  [
    'SBB_INKSCAPE_JITTER_MS',
    'Max startup jitter in ms for parallel Inkscape launches (default: 5000 in CI/tests).'
  ]
];

// ============================================================================
// Low-level rendering helpers
// ============================================================================

/**
 * Pads a string on the right with spaces to the requested width. If the
 * string is already wider, it is returned unchanged (we never truncate).
 *
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function padRight(str, width) {
  const len = str.length;
  if (len >= width) return str;
  return str + ' '.repeat(width - len);
}

/**
 * Wraps a paragraph at the requested width, breaking on word boundaries.
 * The first line gets `firstIndent`; continuation lines get `contIndent`.
 *
 * @param {string} text
 * @param {number} width - Total target width including indentation.
 * @param {string} [firstIndent='']
 * @param {string} [contIndent='']
 * @returns {string[]}
 */
function wrapText(text, width, firstIndent = '', contIndent = '') {
  if (!text) return [firstIndent.trimEnd()];

  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [firstIndent.trimEnd()];

  const lines = [];
  let current = firstIndent;
  let indent = firstIndent;

  for (const word of words) {
    if (current.length === indent.length) {
      // First word on this line — always take it, even if it's wider than width.
      current += word;
      continue;
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current);
      indent = contIndent;
      current = contIndent + word;
    } else {
      current += ' ' + word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// ============================================================================
// Header box
// ============================================================================

/**
 * Renders the branded ASCII box header that appears at the top of every
 * help screen.
 *
 * Layout (78 cols total, double-line box):
 *   ╔════════════════════════════════════════════════════════════════════════╗
 *   ║                                                                        ║
 *   ║   sbb-compare  v1.3.0                                                  ║
 *   ║   <tagline wrapped to fit>                                             ║
 *   ║                                                                        ║
 *   ║   Part of svg-bbox · https://github.com/Emasoft/SVG-BBOX               ║
 *   ║                                                                        ║
 *   ╚════════════════════════════════════════════════════════════════════════╝
 *
 * @param {string} toolName - e.g., 'sbb-compare'.
 * @param {string} tagline  - One-line tool tagline.
 * @returns {string}
 */
function renderHeaderBox(toolName, tagline) {
  const version = getVersion();
  const innerWidth = HEADER_TOTAL_WIDTH - 2; // Subtract the two box-edge chars.
  const contentWidth = innerWidth - HEADER_INNER_PAD * 2; // Inside the padding.

  const top = BOX.topLeft + BOX.horizontal.repeat(innerWidth) + BOX.topRight;
  const bottom = BOX.bottomLeft + BOX.horizontal.repeat(innerWidth) + BOX.bottomRight;
  const blank = BOX.vertical + ' '.repeat(innerWidth) + BOX.vertical;

  /** @param {string} text */
  const rowOf = (text) => {
    const padded = padRight(' '.repeat(HEADER_INNER_PAD) + text, innerWidth);
    return BOX.vertical + padded + BOX.vertical;
  };

  const titleLine = `${toolName}  v${version}`;
  const taglineLines = wrapText(tagline, contentWidth);
  const partOf = `Part of ${PARENT_PACKAGE} · ${REPO_URL}`;

  const rows = [top, blank, rowOf(titleLine)];
  for (const line of taglineLines) rows.push(rowOf(line));
  rows.push(blank, rowOf(partOf), blank, bottom);
  return rows.join('\n');
}

// ============================================================================
// Section headers
// ============================================================================

/**
 * Renders a section header with a single-line rule underneath.
 *
 *   USAGE
 *   ─────
 *
 * @param {string} title
 * @returns {string}
 */
function renderSectionTitle(title) {
  const upper = title.toUpperCase();
  return `${upper}\n${SECTION_RULE.repeat(upper.length)}`;
}

/**
 * Renders a complete section: title, rule, blank line, body.
 *
 * @param {string} title
 * @param {string|string[]} body - Already-formatted body text (or lines).
 * @returns {string}
 */
function renderSection(title, body) {
  const bodyText = Array.isArray(body) ? body.join('\n') : body;
  return `${renderSectionTitle(title)}\n${bodyText}`;
}

// ============================================================================
// Options rendering
// ============================================================================

/**
 * Renders one option (flag) entry.
 *
 *   -j, --json [value]
 *       Output as JSON. If a path is given the report is saved there;
 *       a bare '-' writes JSON to stdout. (default: auto-filename)
 *
 * @param {Object} flag
 * @param {string} flag.name
 * @param {string} [flag.alias]
 * @param {string} [flag.type]
 * @param {string} [flag.description]
 * @param {*} [flag.default]
 * @param {string} [flag.valueLabel] - Override for value placeholder, e.g. '<1-255>'.
 * @returns {string}
 */
function renderOption(flag) {
  const aliasPart = flag.alias ? `-${flag.alias}, ` : '    ';
  const namePart = `--${flag.name}`;

  let valuePart = '';
  if (flag.valueLabel) {
    valuePart = ' ' + flag.valueLabel;
  } else if (flag.type === 'string') {
    valuePart = ' <value>';
  } else if (flag.type === 'number') {
    valuePart = ' <number>';
  } else if (flag.type === 'optional-string') {
    valuePart = ' [value]';
  }

  const header = `  ${aliasPart}${namePart}${valuePart}`;

  const desc = flag.description || '(no description)';
  const defaultStr =
    flag.default !== undefined && flag.default !== null && flag.default !== ''
      ? ` (default: ${flag.default})`
      : '';
  const wrapped = wrapText(desc + defaultStr, 76, '      ', '      ');
  return [header, ...wrapped].join('\n');
}

/**
 * Renders a labeled group of options with a sub-heading.
 *
 *   Common options:
 *     -h, --help          Show this help message
 *     -v, --version       Show version information
 *
 * @param {string} groupLabel
 * @param {Array<*>} flags
 * @returns {string}
 */
function renderOptionGroup(groupLabel, flags) {
  const lines = [`${groupLabel}:`];
  for (const flag of flags) {
    lines.push(renderOption(flag));
    lines.push(''); // Blank line between options for readability.
  }
  // Drop trailing blank.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Splits flags into "basic" and "advanced" groups based on the
 * `advanced: true` property on each OptionDef.
 *
 * @param {Array<*>} flags
 * @returns {{ basic: Array<*>, advanced: Array<*> }}
 */
function splitFlags(flags) {
  /** @type {Array<any>} */
  const basic = [];
  /** @type {Array<any>} */
  const advanced = [];
  for (const f of flags) {
    if (f && f.advanced) advanced.push(f);
    else basic.push(f);
  }
  return { basic, advanced };
}

// ============================================================================
// Examples / batch / fbf / environment / footer
// ============================================================================

/**
 * Renders an examples section.
 *
 *   Compare two SVGs:
 *     sbb-compare design.svg reference.svg
 *
 *   Compare an SVG against a PNG reference:
 *     sbb-compare logo.svg logo-reference.png
 *
 * @param {Array<{title: string, command: string|string[]}>} examples
 * @returns {string}
 */
function renderExamples(examples) {
  if (!examples || examples.length === 0) return '';
  const blocks = [];
  for (const ex of examples) {
    const cmds = Array.isArray(ex.command) ? ex.command : [ex.command];
    const cmdLines = cmds.map((c) => `    ${c}`);
    blocks.push(`  ${ex.title}\n${cmdLines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Renders the standardized BATCH MODE section.
 *
 * @param {Object} spec
 * @param {string} spec.flag - The flag that triggers batch mode (e.g. '--batch').
 * @param {string} spec.argLabel - Argument placeholder (e.g. '<list.txt>').
 * @param {string} spec.formatBody - Multi-line description of the file format.
 * @param {string[]} [spec.examples] - Optional example invocations.
 * @returns {string}
 */
function renderBatchHelp(spec) {
  const lines = [`  ${spec.flag} ${spec.argLabel}`];
  const wrapped = wrapText(spec.formatBody, 76, '    ', '    ');
  for (const line of wrapped) lines.push(line);
  if (spec.examples && spec.examples.length > 0) {
    lines.push('');
    lines.push('  Example invocations:');
    for (const ex of spec.examples) lines.push(`    ${ex}`);
  }
  return lines.join('\n');
}

/**
 * Renders the standardized FBF.SVG section.
 *
 * @param {Object} [spec]
 * @param {Array<{flag: string, description: string}>} spec.flags
 * @returns {string}
 */
function renderFbfHelp(spec) {
  if (!spec || !spec.flags || spec.flags.length === 0) return '';
  const lines = [];
  for (const f of spec.flags) {
    lines.push(`  ${f.flag}`);
    const wrapped = wrapText(f.description, 76, '    ', '    ');
    for (const line of wrapped) lines.push(line);
    lines.push('');
  }
  lines.push('  FBF.SVG (Frame-By-Frame SVG) is the format produced by the svg2fbf');
  lines.push('  companion tool:');
  lines.push(`    ${SISTER_PROJECT_FBF}`);
  return lines.join('\n');
}

/**
 * Renders the standardized ENVIRONMENT section.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.inkscape=false] - Include Inkscape-specific vars.
 * @param {Array<[string, string]>} [opts.extra] - Additional env var entries.
 * @returns {string}
 */
function renderEnvironment(opts = {}) {
  /** @type {Array<[string, string]>} */
  const entries = [...COMMON_ENV_VARS];
  if (opts.inkscape) entries.push(...INKSCAPE_ENV_VARS);
  if (opts.extra) entries.push(...opts.extra);

  // Pad names to align descriptions in a column.
  const maxName = Math.max(...entries.map((entry) => entry[0].length));
  const lines = entries.map((entry) => {
    const name = entry[0];
    const desc = entry[1];
    return `  ${padRight(name, maxName + 2)}${desc}`;
  });
  return lines.join('\n');
}

/**
 * Renders the standardized EXIT CODES section.
 *
 * @param {Array<[number, string]>} [codes]
 * @returns {string}
 */
function renderExitCodes(codes) {
  const entries =
    codes && codes.length > 0
      ? codes
      : [
          [0, 'Success'],
          [1, 'Generic error (invalid input, runtime failure, etc.)']
        ];
  return entries.map(([code, desc]) => `  ${code}  ${desc}`).join('\n');
}

/**
 * Renders the LEARN MORE footer block.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.includeFbfLink=false]
 * @returns {string}
 */
function renderFooter(opts = {}) {
  const lines = [`  README:  ${README_URL}`, `  Issues:  ${ISSUES_URL}`, `  Source:  ${REPO_URL}`];
  if (opts.includeFbfLink) {
    lines.push(`  FBF.SVG companion tool: ${SISTER_PROJECT_FBF}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Top-level composer
// ============================================================================

/**
 * Composes a complete help screen from a structured config object.
 *
 * @param {{
 *   toolName: string,
 *   tagline: string,
 *   description?: string,
 *   usage: string[],
 *   examples?: Array<{title: string, command: string|string[]}>,
 *   commonOptions?: Array<*>,
 *   options?: Array<*>,
 *   advancedOptions?: Array<*>,
 *   batch?: {flag: string, argLabel: string, formatBody: string, examples?: string[]},
 *   fbf?: {flags: Array<{flag: string, description: string}>},
 *   modes?: Object<string, {description: string, flags?: Array<*>}>,
 *   modeFlagsHelp?: string,
 *   environment?: {inkscape?: boolean, extra?: Array<[string, string]>},
 *   exitCodes?: Array<[number, string]>,
 *   notes?: string,
 *   seeAlso?: string
 * }} config
 * @returns {string}
 */
function renderHelp(config) {
  const sections = [];

  // 1. HEADER BOX
  sections.push(renderHeaderBox(config.toolName, config.tagline));

  // 2. DESCRIPTION
  if (config.description) {
    const wrapped = wrapText(config.description, 76, '  ', '  ');
    sections.push(renderSection('Description', wrapped.join('\n')));
  }

  // 3. USAGE
  if (config.usage && config.usage.length > 0) {
    const usageLines = config.usage.map((u) => `  ${u}`).join('\n');
    sections.push(renderSection('Usage', usageLines));
  }

  // 4. EXAMPLES
  if (config.examples && config.examples.length > 0) {
    sections.push(renderSection('Examples', renderExamples(config.examples)));
  }

  // 5. MODES (multi-mode tools only)
  if (config.modes) {
    const modes = config.modes;
    const modeNames = Object.keys(modes);
    const maxLen = Math.max(...modeNames.map((m) => m.length));
    const lines = modeNames.map((name) => {
      const cfg = modes[name];
      const padded = padRight(name, maxLen + 2);
      const desc = cfg ? cfg.description : '';
      return `  ${padded}${desc}`;
    });
    if (config.modeFlagsHelp) {
      lines.push('');
      const wrapped = wrapText(config.modeFlagsHelp, 76, '  ', '  ');
      lines.push(...wrapped);
    }
    sections.push(renderSection('Modes', lines.join('\n')));
  }

  // 6. OPTIONS — common, then basic, then advanced.
  const optionGroups = [];
  if (config.commonOptions && config.commonOptions.length > 0) {
    optionGroups.push(renderOptionGroup('Common options', config.commonOptions));
  }
  if (config.options && config.options.length > 0) {
    const { basic, advanced } = splitFlags(config.options);
    if (basic.length > 0) {
      optionGroups.push(renderOptionGroup('Tool options', basic));
    }
    if (advanced.length > 0) {
      optionGroups.push(
        renderOptionGroup('Advanced options (defaults are usually fine)', advanced)
      );
    }
  }
  if (config.advancedOptions && config.advancedOptions.length > 0) {
    optionGroups.push(
      renderOptionGroup('Advanced options (defaults are usually fine)', config.advancedOptions)
    );
  }
  if (optionGroups.length > 0) {
    sections.push(renderSection('Options', optionGroups.join('\n\n')));
  }

  // 7. BATCH MODE
  if (config.batch) {
    sections.push(renderSection('Batch mode', renderBatchHelp(config.batch)));
  }

  // 8. FBF.SVG
  if (config.fbf) {
    sections.push(renderSection('FBF.SVG support', renderFbfHelp(config.fbf)));
  }

  // 9. ENVIRONMENT
  sections.push(renderSection('Environment', renderEnvironment(config.environment)));

  // 10. EXIT CODES
  sections.push(renderSection('Exit codes', renderExitCodes(config.exitCodes)));

  // 11. NOTES (optional)
  if (config.notes) {
    const wrapped = wrapText(config.notes, 76, '  ', '  ');
    sections.push(renderSection('Notes', wrapped.join('\n')));
  }

  // 12. LEARN MORE / SEE ALSO
  const includeFbfLink = Boolean(config.fbf);
  sections.push(renderSection('Learn more', renderFooter({ includeFbfLink })));

  return sections.join('\n\n') + '\n';
}

// ============================================================================
// Default common-options definitions reused by every tool.
// ============================================================================

/** @type {Array<*>} */
const DEFAULT_COMMON_OPTIONS = [
  {
    name: 'help',
    alias: 'h',
    type: 'boolean',
    description: 'Show this help screen and exit.'
  },
  {
    name: 'version',
    alias: 'v',
    type: 'boolean',
    description: 'Show version information and exit.'
  }
];

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Top-level composer
  renderHelp,

  // Building blocks (exposed for tools that need fine-grained control)
  renderHeaderBox,
  renderSection,
  renderSectionTitle,
  renderOption,
  renderOptionGroup,
  renderExamples,
  renderBatchHelp,
  renderFbfHelp,
  renderEnvironment,
  renderExitCodes,
  renderFooter,
  splitFlags,
  wrapText,
  padRight,

  // Constants
  REPO_URL,
  PARENT_PACKAGE,
  SISTER_PROJECT_FBF,
  ISSUES_URL,
  README_URL,
  COMMON_ENV_VARS,
  INKSCAPE_ENV_VARS,
  DEFAULT_COMMON_OPTIONS
};
