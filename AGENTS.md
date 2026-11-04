# Agent notes

- Package manager: dependencies were installed with pnpm 10.33.0 (`npx -y pnpm@10.33.0 ...` if the global pnpm is older).
- Verify changes with: `pnpm typecheck`, `pnpm format:check`, `pnpm test` (offline, isolated in-memory DB, mocked providers), and `pnpm --filter client exec vite build`.
- Never run tests or smoke servers against `data/app.db`; copy it first (`sqlite3 data/app.db ".backup /tmp/x.db"`) and set `DB_PATH`.
- `client/tests/writingDeskAutoRefine.cjs` (Playwright e2e) relies on these accessible names: 本章完整台本, 小说正文, 台本生成正文, 继续写, 全文精修, 生成新草稿, 采用通过复核的修改, 保留原稿, 登 录. Keep them when changing the writing desk.
- Code style: Prettier (`.prettierrc.json`), no semicolons, single quotes, width 120.
