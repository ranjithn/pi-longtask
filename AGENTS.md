# Development

- Pi extension entry: `index.js`; controller modules: `src/*.mjs`; companion skill: `skills/longtask/`.
- Keep runtime dependency-free ESM. Use public Pi APIs and pi-subagents event contracts, not private imports or another child launcher.
- Preserve fail-closed approval, verification, ownership and cancellation gates. Never add force pushes, automatic merges or destructive recovery.
- Add regression tests in `tests/` for behavior changes; run `npm run check` and `npm test`.
- Check current upstream contracts when changing integrations; document tested versions and limitations in `docs/compatibility.md`.
