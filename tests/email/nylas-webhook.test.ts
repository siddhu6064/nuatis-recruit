/**
 * Integration tests for POST /api/webhooks/nylas
 *
 * Tests HMAC validation, event routing, and graceful handling of unknown types.
 * Does NOT require Inngest dev server — we mock the Inngest send call by
 * checking the HTTP response; actual Inngest wiring is tested via E2E.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";

const BASE = process.env.API_BASE_URL ?? "http://localhost:80/api";
const WEBHOOK_SECRET = "test-nylas-webhook-secret-for-testing-only";

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postWebhook(
  payload: unknown,
  opts: { secret?: string; omitHeader?: boolean } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!opts.omitHeader) {
    headers["x-nylas-signature"] = sign(body, opts.secret ?? WEBHOOK_SECRET);
  }
  return fetch(`${BASE}/webhooks/nylas`, {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/webhooks/nylas — HMAC validation", () => {
  const origSecret = process.env.NYLAS_WEBHOOK_SECRET;

  beforeAll(() => {
    process.env.NYLAS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  afterAll(() => {
    if (origSecret !== undefined) {
      process.env.NYLAS_WEBHOOK_SECRET = origSecret;
    } else {
      delete process.env.NYLAS_WEBHOOK_SECRET;
    }
  });

  it("returns 401 when x-nylas-signature header is missing", async () => {
    const res = await postWebhook({ type: "message.created" }, { omitHeader: true });
    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/signature/i);
  });

  it("returns 401 when x-nylas-signature is incorrect", async () => {
    const res = await postWebhook(
      { type: "message.created", data: { grant_id: "g1", object: { id: "m1", thread_id: "t1" } } },
      { secret: "wrong-secret" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid message.created event", async () => {
    const payload = {
      type: "message.created",
      data: {
        grant_id: "grant_nonexistent_xyz",
        object: { id: "msg_test_abc", thread_id: "thr_test_abc" },
      },
    };
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });

  it("returns 200 for a valid grant.expired event", async () => {
    const payload = {
      type: "grant.expired",
      data: { grant_id: "grant_nonexistent_xyz" },
    };
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });

  it("returns 200 for an unknown event type (silently ignored)", async () => {
    const payload = { type: "calendar.event_created", data: { grant_id: "g1" } };
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });
});
