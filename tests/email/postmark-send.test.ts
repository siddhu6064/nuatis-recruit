/**
 * tests/email/postmark-send.test.ts
 *
 * Unit tests for the Postmark transactional email wrapper.
 *
 * vitest's vi.mock() on a CJS npm package (postmark uses CommonJS) is
 * unreliable when vitest resolves modules with the "module" condition, and
 * vi.spyOn() cannot intercept ES-module-internal call sites. Instead the
 * wrapper exports a _setTestSendEmail() hook that installs a fake sendEmail
 * function directly at the module-variable level — guaranteed to be read by
 * sendTransactional() on every call.
 *
 * Tests:
 *   1. Throws clearly when POSTMARK_SERVER_TOKEN is missing
 *   2. Throws clearly when POSTMARK_FROM_ADDRESS is missing
 *   3. Calls sendEmail with correct args and returns postmarkMessageId
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendTransactional,
  _setTestSendEmail,
} from "../../artifacts/api-server/src/lib/email/postmark";

const ORIG_SERVER_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const ORIG_FROM_ADDRESS = process.env.POSTMARK_FROM_ADDRESS;

beforeEach(() => {
  _setTestSendEmail(null); // ensure clean state
  process.env.POSTMARK_SERVER_TOKEN = "test-token-123";
  process.env.POSTMARK_FROM_ADDRESS = "noreply@example.com";
});

afterEach(() => {
  _setTestSendEmail(null);
  if (ORIG_SERVER_TOKEN === undefined) {
    delete process.env.POSTMARK_SERVER_TOKEN;
  } else {
    process.env.POSTMARK_SERVER_TOKEN = ORIG_SERVER_TOKEN;
  }
  if (ORIG_FROM_ADDRESS === undefined) {
    delete process.env.POSTMARK_FROM_ADDRESS;
  } else {
    process.env.POSTMARK_FROM_ADDRESS = ORIG_FROM_ADDRESS;
  }
});

describe("Postmark sendTransactional", () => {
  it("throws a clear error when POSTMARK_SERVER_TOKEN is not set", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;

    await expect(
      sendTransactional({
        to: "user@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
        tag: "test",
      }),
    ).rejects.toThrow("POSTMARK_SERVER_TOKEN is not set");
  });

  it("throws a clear error when POSTMARK_FROM_ADDRESS is not set", async () => {
    delete process.env.POSTMARK_FROM_ADDRESS;

    await expect(
      sendTransactional({
        to: "user@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
        tag: "test",
      }),
    ).rejects.toThrow("POSTMARK_FROM_ADDRESS is not set");
  });

  it("calls ServerClient.sendEmail with correct args and returns postmarkMessageId", async () => {
    const fakeMessageId = "fake-postmark-guid-1234";
    const mockSendEmail = vi.fn().mockResolvedValueOnce({
      MessageID: fakeMessageId,
      SubmittedAt: "2026-05-02T00:00:00Z",
      ErrorCode: 0,
      Message: "OK",
    });

    _setTestSendEmail(mockSendEmail);

    const result = await sendTransactional({
      to: "recipient@example.com",
      subject: "Alice mentioned you",
      html: "<p>Hello</p>",
      text: "Hello",
      tag: "system-mention",
      metadata: { workspaceId: "ws-123", noteId: "note-456" },
    });

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const callArgs = mockSendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.From).toBe("noreply@example.com");
    expect(callArgs.To).toBe("recipient@example.com");
    expect(callArgs.Subject).toBe("Alice mentioned you");
    expect(callArgs.Tag).toBe("system-mention");
    expect(callArgs.Metadata).toMatchObject({
      workspaceId: "ws-123",
      noteId: "note-456",
    });

    expect(result.postmarkMessageId).toBe(fakeMessageId);
    expect(result.submittedAt).toBeInstanceOf(Date);
  });
});
