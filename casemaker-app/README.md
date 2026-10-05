# React + TypeScript + Vite

## Building (web and desktop)

The app has two build targets, split by what a browser physically cannot do (raw sockets, the
local filesystem, the embedded server). The switch is `BUILD_TARGET` — or its cross-platform
equivalent `--mode desktop`, used by the `tauri:*` scripts — read in `vite.config.ts` and surfaced
through `src/platform/capabilities.ts` (#181).

- **Web (default):** `npm run build` → `dist/`, and `npm run dev` for the dev server. This is what
  `npm run deploy` ships to electricrv.ca; it never sets the desktop target.
- **Desktop:** `npm run tauri:build` (Tauri's `beforeBuildCommand` runs `npm run build:desktop`);
  `npm run tauri:dev` uses `npm run dev:desktop`. A desktop build must never come from the plain
  `build` script.

Desktop-only modules live under `src/platform/desktop/` and are reached only through an
`await import()` inside a `canX` guard, so they never enter the web bundle.
`npm run check:platform-gate` builds the web target and fails if one leaks in. Both targets build
without flipping OS, but `node_modules` is OS-specific — one OS per checkout (`CLAUDE.md`).

**CI has never run on this repo** — the workflows live under `casemaker-app/.github`, not the repo
root, so nothing is automated and every gate is a manual run: `npm run typecheck`, `npm run lint`,
`npm run check:sim-gate`, `npm run check:platform-gate`, and `npx vitest run tests/unit`.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
