/** Keytar service name used for all secrets */
export const KEYTAR_SERVICE = 'claudewatch' as const;
export const API_KEY_ACCOUNT = 'anthropic-admin-key' as const;
export const EMAIL_PASS_ACCOUNT = 'email-password' as const;

/** Pointer stored in TOML so a human can see where the secret lives */
export interface KeytarRef {
  service: string;
  account: string;
}

export type Period = 'daily' | 'weekly' | 'monthly';
export const PERIODS: Period[] = ['daily', 'weekly', 'monthly'];

/**
 * admin — uses Anthropic Admin API (requires sk-ant-admin-... key), org-wide usage
 * personal — uses regular API key (sk-ant-api03-...), tracks local session tokens only
 */
export type Mode = 'admin' | 'personal';

export interface SpendThreshold {
  amountUsd: number;
  period: Period;
  notifyEmail: boolean;
  notifyDesktop: boolean;
}

export type EmailProvider = 'smtp' | 'sendgrid';

export interface EmailConfig {
  provider: EmailProvider;
  host: string;
  port: number;
  secure: boolean;
  /** From address (both providers). Also the SMTP username when provider=smtp. */
  user: string;
  to: string;
}

/** Shape persisted to ~/.claudewatch/config.toml — no secrets */
export interface ConfigFile {
  apiKeyRef: KeytarRef;
  mode: Mode;
  workspaceId: string;
  spendLimitUSD: number | null;
  /** Rolling 7-day spend cap — fires alerts at 80% and 100% */
  weeklySpendLimitUsd: number | null;
  /** Rolling 7-day token count cap — fires alerts at 80% and 100% */
  weeklyTokenLimit: number | null;
  pollIntervalMinutes: number;
  desktop: boolean;
  notifyOnEveryPrompt: boolean;
  thresholds: SpendThreshold[];
  email: EmailConfig | null;
}

/** Runtime config — secrets resolved from system keychain */
export interface Config extends Omit<ConfigFile, 'apiKeyRef'> {
  /** The resolved API key — admin key in admin mode, regular key in personal mode */
  anthropicAdminKey: string;
  emailPassword: string | null;
}

export const DEFAULT_CONFIG_FILE: ConfigFile = {
  apiKeyRef: { service: KEYTAR_SERVICE, account: API_KEY_ACCOUNT },
  mode: 'admin',
  workspaceId: '',
  spendLimitUSD: null,
  weeklySpendLimitUsd: null,
  weeklyTokenLimit: null,
  pollIntervalMinutes: 5,
  desktop: true,
  notifyOnEveryPrompt: false,
  thresholds: [],
  email: null,
};
