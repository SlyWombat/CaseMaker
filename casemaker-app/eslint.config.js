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
    // #1178 — NO STORE SELECTOR MAY BUILD A FRESH SNAPSHOT. zustand v5 + React 19 read a
    // store through `useSyncExternalStore`, whose getSnapshot must be stable between store
    // changes; a selector returning a new object/array per call (a literal body, or a
    // `?? []` / `?? {}` fallback) loops the first store tick. The fix is the store's own
    // reference, a module-level EMPTY, or `useShallow` where a derived object is genuinely
    // needed (the LiveSwath precedent, #1141) — `useShallow`-wrapped selectors are exempt
    // because the callback is not a direct child of the store call, which is exactly what
    // these selectors require.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression > ObjectExpression',
          message: '#1178: a store selector must not build a fresh object — select the store\'s own reference, a module-level EMPTY, or wrap it in useShallow.',
        },
        {
          selector: 'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression > ArrayExpression',
          message: '#1178: a store selector must not build a fresh array — select the store\'s own reference, a module-level EMPTY, or wrap it in useShallow.',
        },
        {
          selector: 'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression > BlockStatement > ReturnStatement > ObjectExpression',
          message: '#1178: a store selector must not return a fresh object — select the store\'s own reference, a module-level EMPTY, or wrap it in useShallow.',
        },
        {
          selector: 'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression > BlockStatement > ReturnStatement > ArrayExpression',
          message: '#1178: a store selector must not return a fresh array — select the store\'s own reference, a module-level EMPTY, or wrap it in useShallow.',
        },
        {
          selector: 'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression LogicalExpression[operator=/^(\\|\\||\\?\\?)$/] > ArrayExpression',
          message: '#1178: a store selector must not fall back to a fresh `?? []` — use a module-level EMPTY constant.',
        },
        {
          selector: 'CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression LogicalExpression[operator=/^(\\|\\||\\?\\?)$/] > ObjectExpression',
          message: '#1178: a store selector must not fall back to a fresh `?? {}` — use a module-level EMPTY constant.',
        },
      ],
    },
  },
  {
    files: ['tests/e2e/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
])
