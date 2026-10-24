// Creates a throw-away account on the local service and prints a bearer token (to stdout, nothing else).
//   REPO_ROOT=$PWD SYNC_BASE=http://127.0.0.1:8795 npx tsx mint-token.ts
import { load, newAccount } from '../common.js';
import type { Crypto } from '../common.js';

const c = await load<Crypto>('src/sync/e2ee/crypto.ts');
const a = await newAccount(process.env['SYNC_BASE'] ?? 'http://127.0.0.1:8795', c);
process.stdout.write(a.token);
