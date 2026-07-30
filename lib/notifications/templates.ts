// D3 — server-owned transactional email templates.
//
// The server is the SOLE author of subject + HTML. Clients pass only a `type`
// enum (never arbitrary text), so there is no injection surface: a compromised
// or malicious client cannot make us send attacker-chosen content to a user.
//
// Brand: dark-first (navy surfaces, cyan accent), Inter typography with safe web
// fallbacks. All CSS is inlined and the layout is table-based for mail-client
// compatibility (Gmail/Apple Mail strip <style> and flexbox).

export const EMAIL_TYPES = ['welcome', 'delete_account'] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

export function isValidEmailType(value: unknown): value is EmailType {
  return typeof value === 'string' && (EMAIL_TYPES as readonly string[]).includes(value);
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Brand tokens (kept in sync with BRAND_SYSTEM.md / style_v2.css).
const NAVY_900 = '#12161c';
const NAVY_800 = '#181a20';
const NAVY_700 = '#23272f';
const CYAN = '#29b6f6';
const INK = '#f8fafc';
const MUTED = '#94a3b8';
const LINE = '#475569';
const FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface Block {
  heading: string;
  intro: string;
  body: string[]; // paragraphs
  outro?: string;
}

function contentFor(type: EmailType): Block {
  switch (type) {
    case 'welcome':
      return {
        heading: 'Welcome to TrackMe',
        intro: "You're all set. TrackMe is ready when you head out the door.",
        body: [
          'TrackMe records your route offline first — no signal required — and keeps every trace yours to export any time.',
          'When it matters, share a time-limited live link with someone you trust. You choose when it starts and when it expires.',
        ],
        outro: 'Have a question? Just reply to this email.',
      };
    case 'delete_account':
      return {
        heading: 'Your account is being deleted',
        intro: 'We received a request to delete your TrackMe account and associated cloud data.',
        body: [
          'This removes your profile, ride history, and any cloud-synced traces. It cannot be undone.',
          "If you did not request this, contact us immediately by replying to this email and we'll help secure your account.",
        ],
        outro: 'Thank you for trusting TrackMe with your routes.',
      };
  }
}

function subjectFor(type: EmailType): string {
  switch (type) {
    case 'welcome':
      return 'Welcome to TrackMe';
    case 'delete_account':
      return 'Your TrackMe account is being deleted';
  }
}

function renderHtml(block: Block): string {
  const paragraphs = block.body
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK};">${p}</p>`,
    )
    .join('');
  const outro = block.outro
    ? `<p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:${MUTED};">${block.outro}</p>`
    : '';

  // Table-based, inline-styled, dark-first. Width 600 is the email standard.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${block.heading}</title>
</head>
<body style="margin:0;padding:0;background:${NAVY_900};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NAVY_900};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${NAVY_800};border:1px solid ${NAVY_700};border-radius:12px;overflow:hidden;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:34px;height:34px;background:${NAVY_900};border:2px solid ${CYAN};border-radius:50%;text-align:center;vertical-align:middle;color:${CYAN};font-family:${FONT_STACK};font-weight:800;font-size:16px;">T</td>
<td style="padding-left:10px;font-family:${FONT_STACK};font-weight:800;font-size:18px;color:${INK};">TrackMe</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 8px;">
<h1 style="margin:0 0 8px;font-family:${FONT_STACK};font-weight:700;font-size:24px;line-height:1.25;color:${INK};">${block.heading}</h1>
<p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${CYAN};">${block.intro}</p>
</td></tr>
<tr><td style="padding:0 32px 8px;font-family:${FONT_STACK};">${paragraphs}${outro}</td></tr>
<tr><td style="padding:24px 32px 32px;">
<hr style="border:none;border-top:1px solid ${LINE};margin:0 0 16px;">
<p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${MUTED};">TrackMe — privacy-first GPS tracking for solo explorers.<br>You are receiving this because you have a TrackMe account.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function renderText(block: Block): string {
  const lines = [block.heading, '', block.intro, '', ...block.body];
  if (block.outro) lines.push('', block.outro);
  lines.push('', '—', 'TrackMe — privacy-first GPS tracking for solo explorers.');
  return lines.join('\n');
}

/** Render the server-owned subject + HTML + text for an allowed email type. */
export function renderEmail(type: EmailType): RenderedEmail {
  const block = contentFor(type);
  return {
    subject: subjectFor(type),
    html: renderHtml(block),
    text: renderText(block),
  };
}
