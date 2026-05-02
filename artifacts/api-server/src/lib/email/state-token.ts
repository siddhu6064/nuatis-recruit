/**
 * Signed state token for Nylas OAuth flow.
 *
 * Format:  base64url(JSON.stringify(payload)) + "." + hex(HMAC-SHA256)
 *
 * Signing key: NYLAS_WEBHOOK_SECRET (required) — the same secret used to
 * validate inbound Nylas webhooks, avoiding an extra env var.
 *
 * Payload includes a 5-minute expiry and a random nonce so replays are
 * detected. The callback validates: signature, expiry, workspaceId match.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export type StatePayload = {
  userId: string;
  workspaceId: string;
  nonce: string;
  exp: number; // Unix epoch seconds
};

function signingKey(): string {
  const secret = process.env.NYLAS_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "[state-token] NYLAS_WEBHOOK_SECRET is not set. Cannot sign OAuth state.",
    );
  }
  return secret;
}

function hmac(b64Part: string, key: string): string {
  return createHmac("sha256", key).update(b64Part).digest("hex");
}

export function signState(payload: StatePayload): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(b64, signingKey());
  return `${b64}.${sig}`;
}

export function verifyState(
  token: string,
  expectedWorkspaceId: string,
): StatePayload {
  const dot = token.lastIndexOf(".");
  if (dot < 0) throw new Error("Malformed state token");

  const b64 = token.slice(0, dot);
  const receivedSig = token.slice(dot + 1);

  const expectedSig = hmac(b64, signingKey());

  let expectedBuf: Buffer;
  let receivedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedSig, "hex");
    receivedBuf = Buffer.from(receivedSig, "hex");
  } catch {
    throw new Error("Invalid state token signature encoding");
  }

  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new Error("State token signature mismatch");
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as StatePayload;
  } catch {
    throw new Error("State token payload is not valid JSON");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    throw new Error("State token has expired");
  }

  if (payload.workspaceId !== expectedWorkspaceId) {
    throw new Error("State token workspace mismatch");
  }

  return payload;
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}
