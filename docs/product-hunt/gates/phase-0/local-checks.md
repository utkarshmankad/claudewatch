# Local check results (2026-10-23)

Revision: `develop` @ `1da206c70534c5c76e31a63f049d98f2839b069b`. Node v22.22.0, Linux, `npm ci` exit 0.

| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npx vitest run` | 27 files, 491 tests passed |
| `npm run test:coverage` | 491 tests passed; all files 63.19% stmts / 51.05% branch / 79.31% funcs / 64.26% lines (repo thresholds not changed) |
| `npm run validate:extension` | "All checks passed" |
| `npm run build` | tsc ok; the chained `node dist/cli/index.js --help` in `npm run check` failed locally: `libsecret-1.so.0` missing (sandbox lacks the keychain runtime that CI installs). Environment limitation, not a code result. |
| `npm run smoke`, `npm run test:browser`, `npm audit` | not run in this sandbox |

CI on the same SHA (authoritative for smoke, browser, audit): CI run 39912776375 and CodeQL run 39912776370, both `success`.
The extension package has no `test` script; its tests run under the root `vitest run`.
