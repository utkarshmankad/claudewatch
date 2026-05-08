import { createInterface } from 'readline';
import { Writable } from 'stream';
import { input } from '@inquirer/prompts';
import keytar from 'keytar';
import type { Config, ConfigFile, EmailConfig, EmailProvider, Mode, SpendThreshold } from './schema.js';
import {
  DEFAULT_CONFIG_FILE,
  EMAIL_PASS_ACCOUNT,
  KEYTAR_SERVICE,
  PERIODS,
} from './schema.js';
import { configExists, saveConfig } from './manager.js';

export * from './schema.js';
export * from './manager.js';

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

export async function runSetupWizard(force = false): Promise<Config> {
  if (configExists() && !force) {
    throw new Error('Already configured. Pass force=true or run: claudewatch setup --reset');
  }

  const { rl, askSecret, close } = createWizardInterface();
  let wizardCompleted = false;

  rl.on('close', () => {
    if (!wizardCompleted) {
      process.stdout.write('\nSetup cancelled.\n');
      process.exit(0);
    }
  });

  try {
    printBanner();

    // --- API key ---
    let anthropicAdminKey = process.env['ANTHROPIC_ADMIN_KEY']?.trim() ?? '';
    if (anthropicAdminKey) {
      process.stdout.write('Using ANTHROPIC_ADMIN_KEY from environment.\n\n');
    } else {
      process.stdout.write(
        'Tip: If paste doesn\'t work, set ANTHROPIC_ADMIN_KEY="sk-ant-admin-..." and re-run.\n\n',
      );
      anthropicAdminKey = (await input({
        message: 'Anthropic API key (Admin sk-ant-admin-... or personal sk-ant-api03-...)',
        validate: (v) => {
          const trimmed = v.trim();
          if (!trimmed) return 'API key is required.';
          if (!trimmed.startsWith('sk-ant-admin') && !trimmed.startsWith('sk-ant-api03-')) {
            return 'Key must start with sk-ant-admin or sk-ant-api03-';
          }
          return true;
        },
      })).trim();
    }

    // Detect mode from key prefix
    const mode: Mode = anthropicAdminKey.startsWith('sk-ant-admin') ? 'admin' : 'personal';
    if (mode === 'personal') {
      process.stdout.write(
        '\nPersonal mode: usage tracked locally only, not from Anthropic\'s servers\n\n',
      );
    }

    // --- Basic settings ---
    const workspaceId = await ask(rl, 'Workspace ID to filter (optional, Enter to skip)', '');
    const spendLimitRaw = await ask(rl, 'Global spend limit USD (optional, Enter for none)', '');
    const spendLimitUSD = spendLimitRaw ? parsePositiveFloat(spendLimitRaw) : null;
    const weeklySpendLimitRaw = await ask(rl, 'Weekly spend limit USD (optional, Enter for none)', '');
    const weeklySpendLimitUsd = weeklySpendLimitRaw ? parsePositiveFloat(weeklySpendLimitRaw) : null;
    const weeklyTokenLimitRaw = await ask(rl, 'Weekly token limit (optional, Enter for none)', '');
    const weeklyTokenLimit = weeklyTokenLimitRaw
      ? (parseInt(weeklyTokenLimitRaw, 10) > 0 ? parseInt(weeklyTokenLimitRaw, 10) : null)
      : null;
    const pollIntervalMinutes = await askInt(rl, 'Poll interval minutes', DEFAULT_CONFIG_FILE.pollIntervalMinutes);
    const desktop = await askBool(rl, 'Enable desktop notifications', true);
    const notifyOnEveryPrompt = await askBool(rl, 'Notify on every prompt (high-volume)', false);

    // --- Email ---
    let email: EmailConfig | null = null;
    let emailPassword: string | undefined;

    const wantsEmail = await askBool(rl, 'Configure email notifications', false);
    if (wantsEmail) {
      const provider = await askEmailProvider(rl);

      if (provider === 'sendgrid') {
        process.stdout.write('\n  SendGrid settings\n');
        const user = await ask(rl, '  Verified sender address (From)', '');
        const to = await ask(rl, '  To address', user);
        emailPassword = await askSecret('  SendGrid API key');
        email = {
          provider,
          host: 'smtp.sendgrid.net',
          port: 587,
          secure: false,
          user,
          to: to || user,
        };
      } else {
        process.stdout.write('\n  SMTP settings\n');
        const host = await ask(rl, '  Host', 'smtp.gmail.com');
        const port = await askInt(rl, '  Port', 587);
        const secure = await askBool(rl, '  TLS/SSL', false);
        const user = await ask(rl, '  From address / username', '');
        const to = await ask(rl, '  To address', user);
        emailPassword = await askSecret('  Email password');
        email = { provider, host, port, secure, user, to: to || user };
      }
    }

    // --- Thresholds ---
    const thresholds: SpendThreshold[] = [];
    process.stdout.write('\n');
    let addThreshold = await askBool(rl, 'Add a spend threshold alert', false);

    while (addThreshold) {
      const amountUsd = await askPositiveFloat(rl, '  Amount USD');
      const period = await askPeriod(rl);
      const notifyEmail = email !== null && await askBool(rl, '  Alert via email', true);
      const notifyDesktop = desktop && await askBool(rl, '  Alert via desktop', true);
      thresholds.push({ amountUsd, period, notifyEmail, notifyDesktop });
      addThreshold = await askBool(rl, '  Add another threshold', false);
    }

    wizardCompleted = true;
    close();

    // --- Persist ---
    const file: ConfigFile = {
      ...DEFAULT_CONFIG_FILE,
      mode,
      workspaceId,
      spendLimitUSD,
      weeklySpendLimitUsd,
      weeklyTokenLimit,
      pollIntervalMinutes,
      desktop,
      notifyOnEveryPrompt,
      thresholds,
      email,
    };

    await saveConfig(file, anthropicAdminKey, emailPassword);

    process.stdout.write('\nConfig saved  → ~/.claudewatch/config.toml\n');
    process.stdout.write('API key stored → system keychain\n');
    if (email) process.stdout.write('Email password → system keychain\n');
    process.stdout.write('\nRun `claudewatch daemon` to start monitoring.\n\n');

    const emailPasswordResolved = emailPassword !== undefined
      ? await keytar.getPassword(KEYTAR_SERVICE, EMAIL_PASS_ACCOUNT)
      : null;

    return {
      mode,
      workspaceId,
      spendLimitUSD,
      weeklySpendLimitUsd,
      weeklyTokenLimit,
      pollIntervalMinutes,
      desktop,
      notifyOnEveryPrompt,
      thresholds,
      email,
      anthropicAdminKey,
      emailPassword: emailPasswordResolved,
    };
  } catch (err) {
    close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

interface WizardInterface {
  rl: ReturnType<typeof createInterface>;
  askSecret: (prompt: string) => Promise<string>;
  close: () => void;
}

function createWizardInterface(): WizardInterface {
  let muted = false;

  // A writable that suppresses output when muted (used for secret masking)
  const output = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });

  const rl = createInterface({ input: process.stdin, output, terminal: true });

  const askSecret = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(`${prompt}: `, (answer) => {
        muted = false;
        process.stdout.write('\n');
        resolve(answer.trim());
      });
      // Set muted AFTER question() so the prompt itself is visible
      muted = true;
    });

  const close = () => rl.close();

  return { rl, askSecret, close };
}

function ask(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  def: string,
): Promise<string> {
  const suffix = def ? ` [${def}]` : '';
  return new Promise((resolve) =>
    rl.question(`${prompt}${suffix}: `, (ans) => resolve(ans.trim() || def)),
  );
}

async function askBool(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  def: boolean,
): Promise<boolean> {
  const hint = def ? 'Y/n' : 'y/N';
  const ans = await ask(rl, `${prompt} (${hint})`, '');
  if (!ans) return def;
  return ans.toLowerCase().startsWith('y');
}

async function askInt(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  def: number,
): Promise<number> {
  const raw = await ask(rl, prompt, String(def));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

async function askPositiveFloat(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<number> {
  for (;;) {
    const raw = await ask(rl, prompt, '');
    const n = parsePositiveFloat(raw);
    if (n !== null) return n;
    process.stdout.write('  Please enter a positive number.\n');
  }
}

async function askPeriod(
  rl: ReturnType<typeof createInterface>,
): Promise<SpendThreshold['period']> {
  for (;;) {
    const raw = await ask(rl, '  Period (daily/weekly/monthly)', 'daily');
    if ((PERIODS as string[]).includes(raw)) return raw as SpendThreshold['period'];
    process.stdout.write('  Must be daily, weekly, or monthly.\n');
  }
}

async function askEmailProvider(
  rl: ReturnType<typeof createInterface>,
): Promise<EmailProvider> {
  for (;;) {
    const raw = await ask(rl, '  Provider (smtp/sendgrid)', 'smtp');
    if (raw === 'smtp' || raw === 'sendgrid') return raw;
    process.stdout.write('  Must be smtp or sendgrid.\n');
  }
}

function parsePositiveFloat(s: string): number | null {
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function printBanner(): void {
  process.stdout.write('\n');
  process.stdout.write('╔══════════════════════════════════╗\n');
  process.stdout.write('║  ClaudeWatch — first-run setup   ║\n');
  process.stdout.write('╚══════════════════════════════════╝\n');
  process.stdout.write('\nYour API key will be stored in the system keychain,\n');
  process.stdout.write('not in the config file.\n\n');
}
