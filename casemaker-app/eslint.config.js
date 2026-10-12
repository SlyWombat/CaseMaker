import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'playwright-report',
    'test-results',
    // #374 — `src-tauri/target` is full of generated JavaScript: the Tauri codegen assets, hashed
    // `.js` files under `release/build/casemaker-*/out/tauri-codegen-assets/`, which this config
    // has no parser for. Lint reported 14 parsing errors on files nobody wrote and nobody can fix.
    // Nothing under `src-tauri` is JavaScript of ours — the crate is Rust, and there is no
    // `.js`/`.mjs`/`.ts` in it outside `target/` — so the whole tree is ignored, for the same
    // reason `vite.config.ts` stops watching it.
    'src-tauri',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The codebase marks deliberately-unused bindings with a leading
      // underscore (uniform compiler-op signatures like `_hats`, keys
      // dropped by rest-destructuring like `_order`). Honour that.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    files: ['tests/e2e/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
])
