# Development and pilot validation

Use Node 22.22.3, pinned in `.nvmrc`, for local development. CI also tests
Node 20 and 22. With nvm installed:

```sh
nvm install
nvm use
npm ci
npx playwright install chromium
npm run check
npm run test:browser
```

On macOS with Homebrew's Node 22 already installed, select it for the current
shell before installing dependencies or running commands:

```sh
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
npm ci
```

Re-run `npm ci` after switching Node major versions: `better-sqlite3` contains
a native binding compiled for the selected Node ABI. Selecting `.nvmrc` is
required; it does not automatically change a shell's active runtime.

`npm run test:browser` builds the dashboard and starts an isolated Vite preview
server on port 4173. Playwright runs Chromium checks for successful spend and
analytics rendering and the daemon-unavailable message. API responses are
mocked; these tests need no credentials or running daemon and do not cover
live provider integration or extension injection. The server stops after tests.

The CI browser job installs Chromium with its Linux dependencies and uploads
the HTML report, failure screenshots, and traces. Locally, open the report with
`npx playwright show-report`. Reports and test results are ignored by Git.

Follow [BRANCHING.md](BRANCHING.md): create feature/fix branches from `develop`,
then open a PR. Both protected branches require one approving review from
another reviewer. The new browser job runs in CI but is not yet a required
ruleset check; add it only after the workflow has been published and verified.
