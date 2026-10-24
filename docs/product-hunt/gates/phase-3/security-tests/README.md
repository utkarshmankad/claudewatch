# Phase 3 security test harnesses

Scripted penetration test, property-based fuzzing and load test for the sync service and client. Results and analysis are in [../security-review.md](../security-review.md). Raw output is in `results/`:

- `pentest.json`, `fuzz.json`, `load.json`: final code.
- `load-before-audit-fix.json`: the load run that exposed the unbounded audit log (LT-1).

**fast-check and autocannon are not repository dependencies.** Install them outside the repo:

```
mkdir /tmp/sectools && cd /tmp/sectools && npm init -y && npm i fast-check@4.10.2 autocannon@8.0.0
```

Then, from the repository root (`R=docs/product-hunt/gates/phase-3/security-tests`):

```
# Penetration test: start the dev service, then attack it. Use a fresh server for each run (limits keep state).
SYNC_DEV_PORT=8791 npx tsx src/sync/service/devServer.ts &
REPO_ROOT=$PWD SYNC_BASE=http://127.0.0.1:8791 npx tsx $R/pentest.ts

# Fuzzing (seed 20261024; the published run used 20000 / 200000 / 10000)
TOOLS_DIR=/tmp/sectools REPO_ROOT=$PWD FUZZ_RUNS=20000 FUZZ_HTTP_RUNS=200000 FUZZ_CLIENT_RUNS=10000 npx tsx $R/fuzz.ts

# Load test (about 2.5 minutes; starts and stops its own server on port 8792)
TOOLS_DIR=/tmp/sectools REPO_ROOT=$PWD LOAD_SERVER=$PWD/$R/loadServer.ts npx tsx $R/load.ts
```

Each script prints JSON and exits non-zero when a check or property fails. They target a local in-memory service only; never point them at a service you do not own. The load numbers depend on the machine (the published run: 4 vCPU, 16 GB, load generator on the same host).
