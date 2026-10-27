// Preference convergence: a last-writer-wins register per key, ordered by the server's sequence number
// (never by device clocks). Writes that did not know about each other and disagree are surfaced as conflicts.
import type { SyncPrefs } from '../e2ee/allowlist.js';

/** Sequence given to a local write that the server has not numbered yet. It orders after every numbered write. */
export const PENDING_SEQ = Number.MAX_SAFE_INTEGER;

export interface PrefWrite {
  value: unknown;
  seq: number; // server sequence of the object carrying the write, or PENDING_SEQ
  by: string; // writing device id
  base: number; // highest server sequence the writer had applied when it wrote
}

export interface PrefConflict {
  key: string;
  winner: PrefWrite;
  loser: PrefWrite;
}

export interface PrefsState {
  register: Record<string, PrefWrite>;
  conflicts: PrefConflict[];
}

export function emptyPrefs(): PrefsState {
  return { register: {}, conflicts: [] };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `a` is the write being applied. Two writes from one device with the same sequence (both pending): the later call wins. */
function newer(a: PrefWrite, b: PrefWrite): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.by === b.by ? true : a.by > b.by;
}

/** Each writer had not seen the other's write. */
function concurrent(a: PrefWrite, b: PrefWrite): boolean {
  return a.by !== b.by && a.base < b.seq && b.base < a.seq;
}

/** Apply a write. Returns true when it changed the visible value. */
export function applyPrefWrite(state: PrefsState, key: string, write: PrefWrite): boolean {
  const current = state.register[key];
  // The echo of our own pending write: adopt the server sequence, keep the value.
  if (current && current.by === write.by && current.seq === PENDING_SEQ && same(current.value, write.value) && write.seq !== PENDING_SEQ) {
    for (const c of state.conflicts) {
      if (c.key !== key) continue;
      if (c.winner === current) c.winner = write;
      if (c.loser === current) c.loser = write;
    }
    state.register[key] = write;
    return false;
  }
  // A later write that had seen both sides of an open conflict resolves it.
  state.conflicts = state.conflicts.filter((c) => !(c.key === key && write.base >= c.winner.seq && write.base >= c.loser.seq && write.seq > c.winner.seq));
  if (!current) {
    state.register[key] = write;
    return true;
  }
  if (same(current.value, write.value)) {
    if (newer(write, current)) state.register[key] = write;
    return false;
  }
  const [winner, loser] = newer(write, current) ? [write, current] : [current, write];
  if (concurrent(winner, loser) && !state.conflicts.some((c) => c.key === key && same(c.loser.value, loser.value) && same(c.winner.value, winner.value))) {
    state.conflicts.push({ key, winner, loser });
  }
  state.register[key] = winner;
  return winner === write;
}

export function visiblePrefs(state: PrefsState): SyncPrefs {
  const out: Record<string, unknown> = {};
  for (const [key, write] of Object.entries(state.register)) out[key] = write.value;
  return out as SyncPrefs;
}
