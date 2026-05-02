/**
 * Unit tests for Nylas wrapper + state-token helpers.
 *
 * No HTTP server needed — pure logic tests using the _setTestNylasClient hook.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  _setTestNylasClient,
  createAuthUrl,
  exchangeCode,
  getMessage,
  type NylasClientInterface,
} from "../../artifacts/api-server/src/lib/email/nylas";
import {
  signState,
  verifyState,
  generateNonce,
} from "../../artifacts/api-server/src/lib/email/state-token";

const WEBHOOK_SECRET = "test-webhook-secret-32chars-long!!";

function withSecret<T>(fn: () => T): T {
  const original = process.env.NYLAS_WEBHOOK_SECRET;
  process.env.NYLAS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.NYLAS_WEBHOOK_SECRET;
    } else {
      process.env.NYLAS_WEBHOOK_SECRET = original;
    }
  }
}

// ── Nylas wrapper: env precheck ────────────────────────────────────────────

describe("Nylas wrapper — env precheck", () => {
  afterEach(() => {
    _setTestNylasClient(null);
  });

  it("throws when NYLAS_CLIENT_ID missing and no test client is set", () => {
    // No test client set → real client factory is called → should throw
    const orig = process.env.NYLAS_CLIENT_ID;
    delete process.env.NYLAS_CLIENT_ID;
    expect(() => createAuthUrl("state", "https://example.com/callback")).toThrow(
      /NYLAS_CLIENT_ID/,
    );
    if (orig !== undefined) process.env.NYLAS_CLIENT_ID = orig;
  });

  it("throws when NYLAS_CLIENT_SECRET missing and no test client is set", () => {
    const origId = process.env.NYLAS_CLIENT_ID;
    const origSecret = process.env.NYLAS_CLIENT_SECRET;
    process.env.NYLAS_CLIENT_ID = "some-id";
    delete process.env.NYLAS_CLIENT_SECRET;
    expect(() => createAuthUrl("state", "https://example.com/callback")).toThrow(
      /NYLAS_CLIENT_SECRET/,
    );
    if (origId !== undefined) process.env.NYLAS_CLIENT_ID = origId;
    else delete process.env.NYLAS_CLIENT_ID;
    if (origSecret !== undefined) process.env.NYLAS_CLIENT_SECRET = origSecret;
  });
});

// ── Nylas wrapper: test hook ───────────────────────────────────────────────

describe("Nylas wrapper — test hook", () => {
  afterEach(() => {
    _setTestNylasClient(null);
  });

  it("routes through injected test client", async () => {
    const mockMessage = {
      id: "msg_test_123",
      threadId: "thr_test_456",
      subject: "Hello",
      from: [{ email: "candidate@example.com" }],
      to: [{ email: "recruiter@company.com" }],
      date: Math.floor(Date.now() / 1000),
    };

    const mockClient: NylasClientInterface = {
      createAuthUrl: () => "https://nylas.example.com/auth?mock=1",
      exchangeCode: async () => ({
        grantId: "grant_test",
        email: "recruiter@company.com",
        provider: "google",
      }),
      getMessage: async () => mockMessage,
      revokeGrant: async () => undefined,
    };
    _setTestNylasClient(mockClient);

    const url = createAuthUrl("state123", "https://app.example.com/callback");
    expect(url).toBe("https://nylas.example.com/auth?mock=1");

    const grant = await exchangeCode("code_xyz", "https://app.example.com/callback");
    expect(grant.grantId).toBe("grant_test");
    expect(grant.provider).toBe("google");

    const msg = await getMessage("grant_test", "msg_test_123");
    expect(msg.id).toBe("msg_test_123");
    expect(msg.threadId).toBe("thr_test_456");
  });
});

// ── State token ────────────────────────────────────────────────────────────

describe("state-token — signState / verifyState", () => {
  it("signs and verifies a valid token", () => {
    withSecret(() => {
      const payload = {
        userId: "user-1",
        workspaceId: "ws-1",
        nonce: generateNonce(),
        exp: Math.floor(Date.now() / 1000) + 300,
      };
      const token = signState(payload);
      const verified = verifyState(token, "ws-1");
      expect(verified.userId).toBe("user-1");
      expect(verified.workspaceId).toBe("ws-1");
    });
  });

  it("rejects a tampered token", () => {
    withSecret(() => {
      const payload = {
        userId: "user-1",
        workspaceId: "ws-1",
        nonce: generateNonce(),
        exp: Math.floor(Date.now() / 1000) + 300,
      };
      const token = signState(payload);
      const tampered = token.slice(0, -4) + "0000";
      expect(() => verifyState(tampered, "ws-1")).toThrow();
    });
  });

  it("rejects an expired token", () => {
    withSecret(() => {
      const payload = {
        userId: "user-1",
        workspaceId: "ws-1",
        nonce: generateNonce(),
        exp: Math.floor(Date.now() / 1000) - 1, // already expired
      };
      const token = signState(payload);
      expect(() => verifyState(token, "ws-1")).toThrow(/expired/);
    });
  });

  it("rejects a token with wrong workspaceId", () => {
    withSecret(() => {
      const payload = {
        userId: "user-1",
        workspaceId: "ws-correct",
        nonce: generateNonce(),
        exp: Math.floor(Date.now() / 1000) + 300,
      };
      const token = signState(payload);
      expect(() => verifyState(token, "ws-wrong")).toThrow(/workspace mismatch/);
    });
  });
});
