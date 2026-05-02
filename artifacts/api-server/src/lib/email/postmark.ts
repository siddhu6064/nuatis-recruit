/**
 * Postmark transactional email wrapper.
 *
 * Env vars required at first call:
 *   POSTMARK_SERVER_TOKEN — Postmark server API token
 *   POSTMARK_FROM_ADDRESS — verified sender address (e.g. noreply@example.com)
 *
 * Both are checked lazily on first send so that processes that never send
 * email (workers that haven't hit the email path yet) don't crash at boot.
 * If either is missing, sendTransactional throws with a clear human-readable
 * error — no silent degradation.
 */
import * as postmark from "postmark";

export type SendTransactionalParams = {
  to: string;
  subject: string;
  html: string;
  text: string;
  tag: string;
  metadata?: Record<string, string>;
};

export type SendTransactionalResult = {
  postmarkMessageId: string;
  submittedAt: Date;
};

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `[email] ${name} is not set. Email sending is unavailable. ` +
        `Set this environment variable before using email routes.`,
    );
  }
  return val;
}

export async function sendTransactional(
  params: SendTransactionalParams,
): Promise<SendTransactionalResult> {
  const token = requireEnv("POSTMARK_SERVER_TOKEN");
  const from = requireEnv("POSTMARK_FROM_ADDRESS");

  const client = new postmark.ServerClient(token);

  const response = await client.sendEmail({
    From: from,
    To: params.to,
    Subject: params.subject,
    HtmlBody: params.html,
    TextBody: params.text,
    Tag: params.tag,
    Metadata: params.metadata,
    MessageStream: "outbound",
  });

  return {
    postmarkMessageId: response.MessageID,
    submittedAt: new Date(response.SubmittedAt),
  };
}
