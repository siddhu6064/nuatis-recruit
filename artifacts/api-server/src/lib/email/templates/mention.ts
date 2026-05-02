/**
 * @mention email template.
 * Subject: "{mentioner} mentioned you in a note on {candidateName}"
 * Body: plaintext + minimal HTML with deep link to candidate detail (notes tab, anchored to note).
 * No design polish — functional only.
 */

export type MentionTemplateParams = {
  mentionerName: string;
  candidateName: string;
  candidateId: string;
  noteId: string;
  snippet: string;
  appBaseUrl: string;
};

export type MentionTemplateResult = {
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMentionEmail(
  params: MentionTemplateParams,
): MentionTemplateResult {
  const { mentionerName, candidateName, candidateId, noteId, snippet, appBaseUrl } =
    params;

  const deepLink = `${appBaseUrl}/candidates/${candidateId}?tab=notes&noteId=${noteId}`;
  const subject = `${mentionerName} mentioned you in a note on ${candidateName}`;

  const text = [
    `Hi,`,
    ``,
    `${mentionerName} mentioned you in a note on candidate ${candidateName}.`,
    ``,
    `Note:`,
    snippet,
    ``,
    `View the note: ${deepLink}`,
    ``,
    `— Nuatis Recruit`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;color:#111827;font-family:sans-serif;font-size:16px">
            <strong>${escapeHtml(mentionerName)}</strong> mentioned you in a note on candidate
            <strong>${escapeHtml(candidateName)}</strong>.
          </p>
          <blockquote style="margin:16px 0;padding:12px 16px;background:#f3f4f6;border-left:3px solid #d1d5db;border-radius:4px;color:#374151;font-family:sans-serif;font-size:14px">
            ${escapeHtml(snippet)}
          </blockquote>
          <p style="margin:24px 0 0;font-family:sans-serif">
            <a href="${deepLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">
              View note →
            </a>
          </p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
          <p style="margin:0;color:#9ca3af;font-family:sans-serif;font-size:12px">
            Nuatis Recruit &middot; This is a system notification. You received this because you were mentioned in a note.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
