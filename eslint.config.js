import js from '@eslint/js';
import vitestPlugin from 'eslint-plugin-vitest';
import prettierConfig from 'eslint-config-prettier';

export default [
  // Base recommended config
  js.configs.recommended,

  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'pnpm-lock.yaml',
      '**/*.min.js',
      'docs_dev/**',
      'scripts_dev/**',
      'libs_dev/**',
      'examples_dev/**',
      'scripts/release/.venv/**',
      '**/.venv/**'
    ]
  },

  // Configuration for ES module JavaScript files
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',

        // Browser globals (for SvgVisualBBox.js and HTML files)
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        Image: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        DOMParser: 'readonly',
        XMLSerializer: 'readonly',
        SVGSVGElement: 'readonly',
        SVGElement: 'readonly',
        Node: 'readonly',
        Promise: 'readonly'
      }
    },
    rules: {
      // Best practices
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // Allow console.log in Node.js scripts
      'no-debugger': 'error',
      'no-alert': 'warn',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'warn',
      'arrow-body-style': ['warn', 'as-needed'],
      'no-duplicate-imports': 'error',
      'no-useless-constructor': 'warn',

      // Code quality
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'all'],
      'brace-style': ['error', '1tbs'],
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      // NOTE: 'no-return-await' removed (2026-01-05 audit) - deprecated in ESLint 8.46.0+
      // Modern JS engines optimize return await automatically

      // Style (minimal, Prettier handles most)
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true }],
      'comma-dangle': ['error', 'never'],
      indent: ['error', 2, { SwitchCase: 1 }],
      'max-len': [
        'warn',
        { code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true }
      ]
    }
  },

  // Configuration for CommonJS files (.cjs)
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      // Best practices
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // Allow console.log in Node.js scripts
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'warn',
      'arrow-body-style': ['warn', 'as-needed'],
      'no-duplicate-imports': 'error',
      'no-useless-constructor': 'warn',

      // Code quality
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'all'],
      'brace-style': ['error', '1tbs'],
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      // NOTE: 'no-return-await' removed (2026-01-05 audit) - deprecated in ESLint 8.46.0+
      // Modern JS engines optimize return await automatically

      // Style (minimal, Prettier handles most)
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true }],
      'comma-dangle': ['error', 'never'],
      indent: ['error', 2, { SwitchCase: 1 }],
      'max-len': [
        'warn',
        { code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true }
      ]
    }
  },

  // Configuration for test files
  {
    files: [
      'tests/**/*.js',
      'tests/**/*.mjs',
      '**/*.test.js',
      '**/*.test.mjs',
      '**/*.spec.js',
      '**/*.spec.mjs'
    ],
    plugins: {
      vitest: vitestPlugin
    },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
      'vitest/expect-expect': ['warn', { assertFunctionNames: ['expect', 'assert', 'assert.*'] }],
      'vitest/no-identical-title': 'error',
      'vitest/no-disabled-tests': 'warn',
      'vitest/no-focused-tests': 'error',
      'vitest/valid-expect': 'error',
      'max-len': 'off' // Allow long lines in tests for readability
    },
    languageOptions: {
      globals: {
        // Test framework globals
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // Browser globals (for E2E tests using Playwright)
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        Element: 'readonly'
      }
    }
  },

  // Configuration for browser-only files
  {
    files: ['SvgVisualBBox.js'],
    rules: {
      'no-undef': 'off' // Disable for UMD pattern
    }
  },

  // Prettier config must be last to disable conflicting rules
  prettierConfig
];
