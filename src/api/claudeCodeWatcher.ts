import { watch } from 'fs';
import { type Dirent, type FSWatcher } from 'fs';
import { readFile, access, stat, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { SnapshotData } from '../store/db.js';

// The real Claude Code data lives in ~/.claude/projects/**/*.jsonl
// Each line is a conversation entry; assistant entries contain message.usage
// with the actual token counts from the API response.
const CLAUDE_DIR      = join(homedir(), '.claude');
const PROJECTS_DIR    = join(CLAUDE_DIR, 'projects');

export type ClaudeCodeUsage = SnapshotData;

export class ClaudeCodeWatcher {
  private watcher: FSWatcher | null = null;
  private onUsage: (u: ClaudeCodeUsage) => void;
  // Track byte offset per file so we only process new lines on each change
  private fileOffsets = new Map<string, number>();

  constructor(onUsage: (u: ClaudeCodeUsage) => void) {
    this.onUsage = onUsage;
  }

  async start(): Promise<void> {
    try {
      await access(CLAUDE_DIR);
    } catch {
      console.warn('[ClaudeCodeWatcher] ~/.claude not found — Claude Code not installed or never run');
      return;
    }

    // Seed offsets to current EOF for all existing JSONL files so we don't
    // re-process historical entries on every daemon start.
    await this.seedOffsets(PROJECTS_DIR);

    console.log(`[ClaudeCodeWatcher] Watching ${PROJECTS_DIR} for new token usage`);

    this.watcher = watch(CLAUDE_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const filePath = resolve(CLAUDE_DIR, filename);
      void this.tailAndEmit(filePath);
    });
  }

  private async seedOffsets(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true, recursive: true });
      for (const entry of entries as Dirent[]) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const dirPath = (entry as Dirent & { parentPath?: string }).parentPath
                       ?? (entry as Dirent & { path?: string }).path
                       ?? dir;
          const fp = join(dirPath, entry.name);
          try {
            const s = await stat(fp);
            this.fileOffsets.set(fp, s.size);
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* projects dir may not exist */ }
  }

  private async tailAndEmit(filePath: string): Promise<void> {
    try {
      const s = await stat(filePath);
      const offset = this.fileOffsets.get(filePath) ?? 0;
      if (s.size <= offset) return; // no new content (e.g. a rename event)

      const raw = await readFile(filePath, 'utf8');
      this.fileOffsets.set(filePath, s.size);

      // Only process the newly appended portion
      const newContent = raw.slice(offset);
      for (const line of newContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          const usage = this.parseEntry(entry);
          if (usage) {
            console.log(
              `[ClaudeCodeWatcher] model=${usage.model ?? '?'}  ` +
              `input=${usage.uncachedInputTokens}  output=${usage.outputTokens}  ` +
              `cacheRead=${usage.cacheReadTokens}`,
            );
            this.onUsage(usage);
          }
        } catch { /* malformed line */ }
      }
    } catch { /* file may have been deleted or be unreadable */ }
  }

  private parseEntry(entry: Record<string, unknown>): ClaudeCodeUsage | null {
    if (entry['type'] !== 'assistant') return null;

    const msg = entry['message'];
    if (!msg || typeof msg !== 'object') return null;
    const message = msg as Record<string, unknown>;

    const usage = message['usage'];
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;

    const inputTokens       = Number(u['input_tokens']               ?? 0);
    const outputTokens      = Number(u['output_tokens']              ?? 0);
    const cacheReadTokens   = Number(u['cache_read_input_tokens']    ?? 0);

    const cacheCreation     = (u['cache_creation'] ?? {}) as Record<string, unknown>;
    const cacheWrite1h      = Number(cacheCreation['ephemeral_1h_input_tokens'] ?? 0);
    const cacheWrite5m      = Number(cacheCreation['ephemeral_5m_input_tokens'] ?? 0);

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) return null;

    const ts = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : new Date().toISOString();

    return {
      recordedAt:          ts,
      bucketStartingAt:    ts,
      bucketEndingAt:      ts,
      model:               typeof message['model'] === 'string' ? message['model'] : 'claude-code',
      sourceTag:           'claude_code',
      uncachedInputTokens: inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWrite1hTokens:  cacheWrite1h,
      cacheWrite5mTokens:  cacheWrite5m,
    };
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
