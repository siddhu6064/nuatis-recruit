/**
 * Nylas v3 API wrapper (using @nylas/nylas SDK v8).
 *
 * ONLY this file (and the Inngest ingest handler) may import from "nylas".
 * All other code goes through these exported functions.
 *
 * Env vars required:
 *   NYLAS_CLIENT_ID      — Nylas application client ID
 *   NYLAS_CLIENT_SECRET  — Nylas application client secret (also used as API key)
 *   NYLAS_API_URI        — optional, defaults to https://api.us.nylas.com
 *
 * Test hook: call _setTestNylasClient(mock) before the test, then
 * _setTestNylasClient(null) in afterEach. This avoids vi.mock() on a CJS
 * package (same pattern as postmark's _setTestSendEmail).
 */
import Nylas from "nylas";

// ── Exported types ─────────────────────────────────────────────────────────

export type NylasEmailName = { email: string; name?: string };

export type NylasMessage = {
  id: string;
  threadId?: string;
  subject?: string;
  body?: string;
  snippet?: string;
  from?: NylasEmailName[];
  to?: NylasEmailName[];
  cc?: NylasEmailName[];
  bcc?: NylasEmailName[];
  date?: number; // Unix timestamp in seconds
};

export type NylasGrantInfo = {
  grantId: string;
  email: string;
  provider: string; // "google" | "microsoft" | "imap" | ...
};

export type NylasClientInterface = {
  createAuthUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<NylasGrantInfo>;
  getMessage(grantId: string, messageId: string): Promise<NylasMessage>;
  revokeGrant(grantId: string): Promise<void>;
};

// ── Module-level test hook (same pattern as postmark) ──────────────────────

let _testClientOverride: NylasClientInterface | null = null;

/** @internal — for use in tests only */
export function _setTestNylasClient(client: NylasClientInterface | null): void {
  _testClientOverride = client;
}

// ── Env helpers ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `[nylas] ${name} is not set. Nylas integration is unavailable. ` +
        `Set this environment variable before using email OAuth routes.`,
    );
  }
  return val;
}

// ── Real client factory ────────────────────────────────────────────────────

function makeRealClient(): NylasClientInterface {
  const clientId = requireEnv("NYLAS_CLIENT_ID");
  const clientSecret = requireEnv("NYLAS_CLIENT_SECRET");
  const apiUri = process.env.NYLAS_API_URI ?? "https://api.us.nylas.com";

  const nylas = new Nylas({ apiKey: clientSecret, apiUri });

  return {
    createAuthUrl(state: string, redirectUri: string): string {
      return nylas.auth.urlForOAuth2({ clientId, redirectUri, state });
    },

    async exchangeCode(code: string, redirectUri: string): Promise<NylasGrantInfo> {
      const result = await nylas.auth.exchangeCodeForToken({
        clientId,
        clientSecret,
        redirectUri,
        code,
      });
      const r = result as unknown as Record<string, unknown>;
      return {
        grantId: result.grantId,
        email: (r.email as string | undefined) ?? "",
        provider: (r.provider as string | undefined) ?? "imap",
      };
    },

    async getMessage(grantId: string, messageId: string): Promise<NylasMessage> {
      const response = await nylas.messages.find({ identifier: grantId, messageId });
      const msg = response.data as unknown as Record<string, unknown>;
      return {
        id: msg.id as string,
        threadId: (msg.threadId ?? msg.thread_id) as string | undefined,
        subject: msg.subject as string | undefined,
        body: msg.body as string | undefined,
        snippet: msg.snippet as string | undefined,
        from: msg.from as NylasEmailName[] | undefined,
        to: msg.to as NylasEmailName[] | undefined,
        cc: msg.cc as NylasEmailName[] | undefined,
        bcc: msg.bcc as NylasEmailName[] | undefined,
        date: msg.date as number | undefined,
      };
    },

    async revokeGrant(grantId: string): Promise<void> {
      try {
        await nylas.auth.revoke(grantId);
      } catch (err) {
        // Log but don't throw — Nylas may already have revoked it
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[nylas] revokeGrant failed: ${message}`);
      }
    },
  };
}

// ── Public API — delegates to test override or real client ────────────────

function getClient(): NylasClientInterface {
  return _testClientOverride ?? makeRealClient();
}

export function createAuthUrl(state: string, redirectUri: string): string {
  return getClient().createAuthUrl(state, redirectUri);
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<NylasGrantInfo> {
  return getClient().exchangeCode(code, redirectUri);
}

export async function getMessage(
  grantId: string,
  messageId: string,
): Promise<NylasMessage> {
  return getClient().getMessage(grantId, messageId);
}

export async function revokeGrant(grantId: string): Promise<void> {
  return getClient().revokeGrant(grantId);
}
