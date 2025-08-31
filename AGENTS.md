# Repository Guidelines

## Project Structure & Module Organization
- `src/`: extension source
  - `background/`, `content/`, `options/`, `common/`, `assets/`, `_locales/`
  - `manifest.json` (MV3) transformed during build by `src/addVariablesToManifest.js`.
- `build/`: webpack output (`background.js`, `content.js`, `options.js`, CSS, manifest, icons).
- `tests/`: Jest + Puppeteer tests against dummy pages (`tests/specs/*.spec.js`).
- `e2e/`: Firefox end-to-end via `web-ext` + `puppeteer-core`.
- `scripts/`: utility scripts (e.g., `scripts/check-urls.js`).
- `.github/`: CI workflows (Node.js CI, release on version bump).

## Build, Test, and Development Commands
- `npm start`: dev build with watch + sourcemaps.
- `npm run build`: production build to `build/`.
- `npm test`: build in test mode, then run Jest (Puppeteer) using `tests/jest.config.js`.
- `npm run test:e2e`: run Firefox E2E (`e2e/e2e.spec.js`).
- `npm run test:e2e:xvfb`: CI-friendly E2E with Xvfb.
- `npm run release`: clean build and create `funda-neighbourhoods-v<version>.zip`.

## Coding Style & Naming Conventions
- Language: modern JS; modules bundled by webpack.
- Indentation: 2 spaces; prefer named exports.
- Prettier: enforced (`.prettierrc`: `printWidth: 120`, `arrowParens: avoid`).
- Naming: `camelCase` for vars/functions; `UPPER_SNAKE_CASE` for constants (see `src/common/constants.js`).
- Test hooks: add stable selectors via `data-test`, e.g. `badge-<name>`, `optionsPagePropertyCheckbox-<name>`.

## Testing Guidelines
- Frameworks: Jest + Puppeteer (`jest-puppeteer` preset).
- Location: specs in `tests/specs/*.spec.js`; E2E in `e2e/e2e.spec.js`.
- Run: `npm test` (unit/integration) or `npm run test:e2e` (requires a fresh `npm run build`).
- Conventions: keep tests deterministic; prefer selecting elements via `data-test` attributes; update dummy pages if needed.

## Commit & Pull Request Guidelines
- Commits: imperative, concise message (e.g., `feat(content): add income bands`).
- PRs: clear description, linked issues, before/after screenshots for UI changes, note any manifest/permission changes.
- CI: ensure `npm test` passes locally; bump `package.json` version on main to trigger automated release.
- Versioning: after every commit that changes the repository, increment `package.json` version by +1 (patch bump) and produce a fresh build (`npm run build`).

## Security & Configuration Tips
- Node: use `.nvmrc` (`nvm use`) to match Node LTS Erbium (12.x).
- Permissions: minimize `host_permissions`; discuss additions in PRs.
- Secrets: none required; only public data APIs are used.
