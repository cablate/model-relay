# Contributing

Contributions, bug reports, and provider compatibility notes are welcome.

## Development setup

1. Clone the repository and ensure Node.js 20+ and Claude Code CLI are installed.
2. Run the test suite:

```bash
node tools/check.mjs
npx -y -p typescript tsc -p .
claude plugin validate .
claude plugin test .
```

## Writing docs

Public documentation (`README.md` / `README.zh-TW.md` and `CHANGELOG.md` / `CHANGELOG.zh-TW.md`) is maintained in both English and Traditional Chinese. Every heading, list item, table row, and code block must correspond 1-to-1 across both files. Run `node tools/docs.mjs check` before committing.

## Releasing

1. Bump `"version"` in `.claude-plugin/plugin.json`.
2. Update `[Unreleased]` in both `CHANGELOG.md` and `CHANGELOG.zh-TW.md` with the new version and date.
3. Run `node tools/check.mjs` and confirm all checks pass, then `node tools/smoke.mjs` (one real Claude Code request through this checkout's router; CI cannot run it because it needs a logged-in `claude`).
4. Tag the release and generate bilingual release notes with `node tools/docs.mjs release <version>`.
