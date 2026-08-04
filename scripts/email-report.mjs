#!/usr/bin/env node
/**
 * email-report.mjs — Emails the Pulse daily health report to Rahil.
 *
 * Companion to scripts/daily-health-report.mjs. That script generates a
 * deterministic report at reports/pulse-daily-YYYY-MM-DD.md and prints it. This
 * script reads that same file (today's, or the most recent) and emails it, so the
 * report lands in Rahil's inbox instead of only the Dispatch feed.
 *
 * WHY SMTP + APP PASSWORD (not the Gmail connector): the Gmail MCP connector can
 * only create DRAFTS, not send. A draft to yourself never arrives as a received
 * mail. Gmail SMTP with a 16-char App Password sends a real message from Rahil's
 * own Gmail to his own inbox — deterministic, headless, no draft step.
 *
 * SETUP (one time, done by Rahil — Claude never handles the secret):
 *   1. Google Account → Security → 2-Step Verification must be ON.
 *   2. Google Account → Security → App passwords → create one named "career-ops".
 *   3. Paste the 16-char password into career-ops/.env as:
 *        GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
 *      (optional) GMAIL_USER=rahilpmp@gmail.com   # sending account, default below
 *      (optional) REPORT_EMAIL_TO=rahilpmp@gmail.com  # recipient, default = sender
 *
 * CLI:
 *   node scripts/email-report.mjs            # send today's report (or most recent)
 *   node scripts/email-report.mjs --dry-run  # show what would be sent, send nothing
 *   node scripts/email-report.mjs --file <path>  # email a specific report file
 *
 * Exit codes:
 *   0 = sent, or cleanly skipped (no app password yet — degrades loudly, never
 *       breaks the report pipeline)
 *   1 = a real failure (report file unreadable, SMTP rejected the send)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');

const DEFAULT_SENDER = 'rahilpmp@gmail.com';

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

/** Newest reports/pulse-daily-*.md, or null if none exist. */
export function findLatestReport(dir = REPORTS_DIR) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /^pulse-daily-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** Newest reports/pulse-board-*.png (the pipeline snapshot), or null. */
export function findLatestBoardImage(dir = REPORTS_DIR) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /^pulse-board-\d{4}-\d{2}-\d{2}\.png$/.test(f))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** Pull a one-line subject out of the report body (health band + score + date). */
export function buildSubject(reportText, fallbackDate = '') {
  const dateMatch = reportText.match(/# Pulse Daily\s*[—-]\s*(\d{4}-\d{2}-\d{2})/);
  const healthMatch = reportText.match(/\*\*Health:\*\*\s*([A-Za-z]+)/);
  const scoreMatch = reportText.match(/\*\*Score:\*\*\s*([0-9]+\/100[^·\n]*)/);
  const date = dateMatch ? dateMatch[1] : (fallbackDate || 'today');
  const health = healthMatch ? healthMatch[1] : '';
  const score = scoreMatch ? scoreMatch[1].trim() : '';
  const tail = [health, score].filter(Boolean).join(' ');
  return tail ? `Job Pulse Daily — ${date} — ${tail}` : `Job Pulse Daily — ${date}`;
}

/** Minimal markdown-to-HTML so the mail is readable in a Gmail client. */
export function toHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;white-space:pre-wrap">${esc(md)}</pre>`;
}

async function main() {
  // Bootstrap .env (optional dependency, mirrors airtable-sync.mjs) so
  // GMAIL_APP_PASSWORD / GMAIL_USER / REPORT_EMAIL_TO are picked up.
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional */ }

  const DRY_RUN = process.argv.includes('--dry-run');
  const fileArg = argVal('--file');

  const reportPath = fileArg || findLatestReport();
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error('[email-report] FATAL: no report file found in reports/pulse-daily-*.md. Run `npm run pulse:daily-report` first.');
    process.exit(1);
  }

  let reportText;
  try {
    reportText = fs.readFileSync(reportPath, 'utf8');
  } catch (e) {
    console.error(`[email-report] FATAL: cannot read report ${reportPath}: ${e.message}`);
    process.exit(1);
  }

  const subject = buildSubject(reportText);
  const sender = process.env.GMAIL_USER || DEFAULT_SENDER;
  const recipient = process.env.REPORT_EMAIL_TO || sender;
  // Gmail displays app passwords as 4 space-separated groups ("abcd efgh ijkl
  // mnop"), but the real secret is 16 chars with no spaces. Users almost always
  // paste it with the spaces, which Gmail then rejects as BadCredentials. Strip
  // all whitespace (and any stray surrounding quotes) so a copy-paste just works.
  const appPassword = (process.env.GMAIL_APP_PASSWORD || '')
    .replace(/["']/g, '')
    .replace(/\s+/g, '') || null;

  console.log(`[email-report] report: ${path.relative(ROOT, reportPath)}`);
  console.log(`[email-report] subject: ${subject}`);
  console.log(`[email-report] from: ${sender} → to: ${recipient}`);

  if (DRY_RUN) {
    console.log('[email-report] DRY-RUN — not sending. Body preview (first 400 chars):\n');
    console.log(reportText.slice(0, 400));
    process.exit(0);
  }

  // Degrade loudly, not fatally: without the app password the report task still
  // succeeds and surfaces the report; the email is simply skipped with a clear note.
  if (!appPassword) {
    console.log('[email-report] SKIPPED — GMAIL_APP_PASSWORD not set in .env. See setup steps at the top of this file. The report itself is unaffected.');
    process.exit(0);
  }

  // Safe diagnostic — length only, never the secret. A valid Gmail app password
  // is exactly 16 chars after whitespace is stripped. Anything else means the
  // value in .env is truncated, padded, or not actually an app password.
  console.log(`[email-report] app password length (after cleanup): ${appPassword.length} (Gmail app passwords are exactly 16)`);

  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    console.error('[email-report] FATAL: nodemailer not installed. Run: npm install nodemailer');
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: sender, pass: appPassword },
  });

  // Attach the pipeline board snapshot if one was rendered for today. Shown
  // inline above the text report, and also attached as a downloadable file.
  // Missing image is fine — the email still goes with just the report text.
  const boardImg = findLatestBoardImage();
  const attachments = [];
  let htmlBody = toHtml(reportText);
  if (boardImg && fs.existsSync(boardImg)) {
    const cid = 'pulse-board@career-ops';
    attachments.push({ filename: path.basename(boardImg), path: boardImg, cid });
    htmlBody = `<img src="cid:${cid}" alt="Job Pulse board snapshot" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:16px" />` + htmlBody;
    console.log(`[email-report] attaching board snapshot: ${path.relative(ROOT, boardImg)}`);
  } else {
    console.log('[email-report] no board snapshot found — sending report text only.');
  }

  try {
    const info = await transport.sendMail({
      from: sender,
      to: recipient,
      subject,
      text: reportText,
      html: htmlBody,
      attachments,
    });
    console.log(`[email-report] SENT — messageId ${info.messageId}`);
    process.exit(0);
  } catch (e) {
    console.error(`[email-report] FATAL: SMTP send failed: ${e.message}`);
    console.error(`[email-report] Sender account: ${sender}. The app password MUST have been created while signed into THIS exact account.`);
    console.error('[email-report] Checklist: (1) length above must be 16, (2) app password created under ' + sender + ' specifically, (3) 2-Step Verification ON for that account, (4) if you have multiple Google logins, you likely made it on the wrong one — delete it and recreate while signed into ' + sender + '.');
    process.exit(1);
  }
}

const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.error(`[email-report] FATAL: ${e.message}`);
    process.exit(1);
  });
}
