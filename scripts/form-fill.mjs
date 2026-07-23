#!/usr/bin/env node
/**
 * form-fill.mjs — Playwright form-fill helpers for Greenhouse, Lever, Workday, and generic ATS.
 *
 * Each fill function returns a FillReport:
 *   { filled, total, missing_fields, upload_details, ats }
 *
 * "filled" = field was present AND we successfully set a value.
 * "missing_fields" = fields we tried but couldn't locate or fill.
 * "upload_details" = { resume?: UploadResult, cl?: UploadResult } — per-upload diagnostics.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Text-field helpers ────────────────────────────────────────────────────────

async function tryFill(locator, value) {
  if (!value) return false;
  try {
    const count = await locator.count();
    if (count === 0) return false;
    await locator.first().fill(String(value));
    return true;
  } catch {
    return false;
  }
}

async function trySelect(locator, label) {
  if (!label) return false;
  try {
    const count = await locator.count();
    if (count === 0) return false;
    try {
      await locator.first().selectOption({ label });
    } catch {
      await locator.first().selectOption(label);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Layered file-upload helpers ───────────────────────────────────────────────
//
// Each helper tries a prioritised list of selectors. Returns an UploadResult
// so the caller can log exactly what matched (or why it failed).
//
// Industry term: "resilient selectors" — try 8-10 strategies per field so that
// minor DOM changes in a particular ATS instance don't silently block the upload.

export const RESUME_SELECTORS = [
  'input[type="file"][aria-label*="resume" i]',
  'input[type="file"][aria-label*="cv" i]',
  'input[type="file"][id*="resume" i]',
  'input[type="file"][name*="resume" i]',
  'input[type="file"][id*="cv" i]',
  'input[type="file"][name*="cv" i]',
  'input[type="file"][data-source="resume"]',
  'label:has-text("Resume") + input[type="file"]',
  'label:has-text("Resume") ~ input[type="file"]',
  'label:has-text("CV") + input[type="file"]',
];

export const CL_SELECTORS = [
  'input[type="file"][aria-label*="cover letter" i]',
  'input[type="file"][aria-label*="cover" i]',
  'input[type="file"][id*="cover_letter" i]',
  'input[type="file"][id*="cover-letter" i]',
  'input[type="file"][name*="cover_letter" i]',
  'input[type="file"][name*="cover-letter" i]',
  'input[type="file"][data-source="cover_letter"]',
  'label:has-text("Cover Letter") + input[type="file"]',
  'label:has-text("Cover Letter") ~ input[type="file"]',
];

/**
 * @typedef {Object} UploadResult
 * @property {boolean} uploaded
 * @property {string}  [reason]   'no_path' | 'file_missing' | 'no_matching_input'
 * @property {string}  [selector] Matched selector (when uploaded=true)
 * @property {string}  [path]     File path used
 * @property {number}  [tried]    Selector count tried (when no_matching_input)
 */

/**
 * Upload the candidate's resume using a layered selector strategy.
 */
export async function uploadResume(page, personal) {
  const filePath = personal.resume?.path;
  if (!filePath) return { uploaded: false, reason: 'no_path' };
  if (!fs.existsSync(filePath)) return { uploaded: false, reason: 'file_missing', path: filePath };

  for (const sel of RESUME_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.setInputFiles(filePath);
        return { uploaded: true, selector: sel, path: filePath };
      }
    } catch { /* try next */ }
  }
  return { uploaded: false, reason: 'no_matching_input', tried: RESUME_SELECTORS.length };
}

/**
 * Upload a cover letter using a layered selector strategy.
 * Prefers matchedClPath, falls back to personal.cover_letter.default_path.
 */
export async function uploadCoverLetter(page, personal, matchedClPath = null) {
  const filePath = matchedClPath || personal.cover_letter?.default_path;
  if (!filePath) return { uploaded: false, reason: 'no_path' };
  if (!fs.existsSync(filePath)) return { uploaded: false, reason: 'file_missing', path: filePath };

  for (const sel of CL_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.setInputFiles(filePath);
        return { uploaded: true, selector: sel, path: filePath };
      }
    } catch { /* try next */ }
  }
  return { uploaded: false, reason: 'no_matching_input', tried: CL_SELECTORS.length };
}

/**
 * Format upload details for console output.
 * @param {{ resume?: UploadResult, cl?: UploadResult }} details
 * @returns {string[]} Lines to print
 */
export function formatUploadDetails(details) {
  const lines = [];
  if (details.resume) {
    const r = details.resume;
    if (r.uploaded) {
      lines.push(`  Resume: uploaded ${path.basename(r.path)} (via ${r.selector})`);
    } else if (r.reason === 'no_path') {
      lines.push('  Resume: skipped (resume.path not set in personal-info.yml)');
    } else if (r.reason === 'file_missing') {
      lines.push(`  Resume: NOT uploaded — file not found: ${r.path}`);
    } else {
      lines.push(`  Resume: NOT uploaded — no_matching_input (tried ${r.tried} selectors)`);
    }
  }
  if (details.cl) {
    const c = details.cl;
    if (c.uploaded) {
      lines.push(`  CL:     uploaded ${path.basename(c.path)} (via ${c.selector})`);
    } else if (c.reason === 'no_path') {
      lines.push('  CL:     skipped (no matched CL and no default_path set)');
    } else if (c.reason === 'file_missing') {
      lines.push(`  CL:     NOT uploaded — file not found: ${c.path}`);
    } else {
      lines.push(`  CL:     NOT uploaded — no_matching_input (tried ${c.tried} selectors)`);
    }
  }
  return lines;
}

// ── Greenhouse ────────────────────────────────────────────────────────────────

/**
 * Fill a standard Greenhouse application form.
 * @param {import('playwright').Page} page
 * @param {object} personal  Output of loadPersonalInfo()
 * @param {string|null} clPath  Resolved CL file path (or null → personal.cover_letter.default_path)
 * @returns {FillReport}
 */
export async function fillGreenhouseForm(page, personal, clPath = null) {
  const fields = [
    { name: 'first_name', fn: () => tryFill(page.locator('input[autocomplete="given-name"], input[name="first_name"], input[id*="first"]').first(), personal.name?.first) },
    { name: 'last_name',  fn: () => tryFill(page.locator('input[autocomplete="family-name"], input[name="last_name"], input[id*="last"]').first(), personal.name?.last) },
    { name: 'email',      fn: () => tryFill(page.locator('input[autocomplete="email"], input[type="email"], input[name="email"]').first(), personal.contact?.email) },
    { name: 'phone',      fn: () => tryFill(page.locator('input[autocomplete="tel"], input[type="tel"], input[name="phone"]').first(), personal.contact?.phone) },
    { name: 'city',       fn: () => tryFill(page.locator('input[autocomplete="address-level2"], input[name="city"]').first(), personal.location?.city) },
    { name: 'linkedin',   fn: () => tryFill(
      page.locator('label:has-text("LinkedIn"), label:has-text("linkedin")').locator('xpath=following::input[1]').first(),
      personal.links?.linkedin
    ) },
    { name: 'work_auth',  fn: () => trySelect(
      page.locator('label:has-text("authorized to work"), label:has-text("authorized to legally work")').locator('xpath=following::select[1]').first(),
      personal.custom?.authorized_to_work ? 'Yes' : 'No'
    ) },
    { name: 'sponsorship', fn: () => trySelect(
      page.locator('label:has-text("require sponsorship"), label:has-text("require visa sponsorship")').locator('xpath=following::select[1]').first(),
      personal.work_auth?.requires_sponsorship ? 'Yes' : 'No'
    ) },
    { name: 'resume_upload', type: 'upload', key: 'resume', fn: () => uploadResume(page, personal) },
    { name: 'cl_upload',     type: 'upload', key: 'cl',     fn: () => uploadCoverLetter(page, personal, clPath) },
  ];

  return _runFields(fields, 'greenhouse');
}

// ── Lever ─────────────────────────────────────────────────────────────────────

export async function fillLeverForm(page, personal, clPath = null) {
  const fields = [
    { name: 'name',   fn: () => tryFill(page.locator('input[name="name"], input[autocomplete="name"]').first(), personal.name?.full) },
    { name: 'email',  fn: () => tryFill(page.locator('input[name="email"], input[type="email"]').first(), personal.contact?.email) },
    { name: 'phone',  fn: () => tryFill(page.locator('input[name="phone"], input[type="tel"]').first(), personal.contact?.phone) },
    { name: 'org',    fn: () => tryFill(page.locator('input[name="org"], input[placeholder*="company" i], input[placeholder*="current employer" i]').first(), personal.experience?.current_company) },
    { name: 'linkedin', fn: () => tryFill(page.locator('input[name="urls[LinkedIn]"], input[placeholder*="linkedin" i]').first(), personal.links?.linkedin) },
    { name: 'resume_upload', type: 'upload', key: 'resume', fn: () => uploadResume(page, personal) },
    { name: 'cl_upload',     type: 'upload', key: 'cl',     fn: () => uploadCoverLetter(page, personal, clPath) },
  ];

  return _runFields(fields, 'lever');
}

// ── Workday ───────────────────────────────────────────────────────────────────

export async function fillWorkdayForm(page, personal, clPath = null) {
  const fields = [
    { name: 'first_name', fn: () => tryFill(page.locator('[data-automation-id="legalNameSection_firstName"], input[aria-label*="First Name" i]').first(), personal.name?.first) },
    { name: 'last_name',  fn: () => tryFill(page.locator('[data-automation-id="legalNameSection_lastName"], input[aria-label*="Last Name" i]').first(), personal.name?.last) },
    { name: 'email',      fn: () => tryFill(page.locator('[data-automation-id="email"], input[aria-label*="Email" i]').first(), personal.contact?.email) },
    { name: 'phone',      fn: () => tryFill(page.locator('[data-automation-id="phone"], input[aria-label*="Phone" i]').first(), personal.contact?.phone) },
    { name: 'resume_upload', type: 'upload', key: 'resume', fn: () => uploadResume(page, personal) },
    { name: 'cl_upload',     type: 'upload', key: 'cl',     fn: () => uploadCoverLetter(page, personal, clPath) },
  ];

  return _runFields(fields, 'workday');
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
// B-0716-ASHBY: Ashby sets NO autocomplete attributes, so the generic fallback
// filled only email (input[type=email]) and left the required Name/Phone empty
// — submit clicks then died on client-side validation (Lambda ×3, 2026-07-16).
// System fields have stable ids (_systemfield_name/email/resume); custom fields
// (phone, LinkedIn) have uuid ids, so match by type / label proximity.

export async function fillAshbyForm(page, personal, clPath = null) {
  const fields = [
    { name: 'name',   fn: () => tryFill(page.locator('#_systemfield_name, input[name="_systemfield_name"]').first(), personal.name?.full) },
    { name: 'email',  fn: () => tryFill(page.locator('#_systemfield_email, input[name="_systemfield_email"], input[type="email"]').first(), personal.contact?.email) },
    { name: 'phone',  fn: () => tryFill(page.locator('input[type="tel"]').first(), personal.contact?.phone) },
    { name: 'linkedin', fn: () => tryFill(page.getByLabel(/linkedin/i).first(), personal.links?.linkedin) },
    { name: 'resume_upload', type: 'upload', key: 'resume', fn: () => uploadResume(page, personal) },
    { name: 'cl_upload',     type: 'upload', key: 'cl',     fn: () => uploadCoverLetter(page, personal, clPath) },
  ];

  return _runFields(fields, 'ashby');
}

// ── Generic fallback ──────────────────────────────────────────────────────────

export async function fillGenericForm(page, personal, clPath = null) {
  const fields = [
    { name: 'given_name',  fn: () => tryFill(page.locator('input[autocomplete="given-name"]').first(),  personal.name?.first) },
    { name: 'family_name', fn: () => tryFill(page.locator('input[autocomplete="family-name"]').first(), personal.name?.last) },
    { name: 'email',       fn: () => tryFill(page.locator('input[autocomplete="email"], input[type="email"]').first(), personal.contact?.email) },
    { name: 'tel',         fn: () => tryFill(page.locator('input[autocomplete="tel"], input[type="tel"]').first(), personal.contact?.phone) },
    { name: 'resume_upload', type: 'upload', key: 'resume', fn: () => uploadResume(page, personal) },
  ];

  return _runFields(fields, 'generic');
}

// ── Iframe-aware form-frame resolution ────────────────────────────────────────
//
// K-DEFECT-2026-07-13: same root cause as auto-submit.mjs's findSubmitOnPage
// fix (K-DEFECT-2026-07-07) — Greenhouse embeds (confirmed live on
// careerpuck.com/Lyft) wrap the real form in an <iframe>, and page.locator()
// only ever searches the MAIN frame. findSubmitOnPage was fixed to search
// child frames; form-fill.mjs was not, so on an iframe-embedded posting the
// fill functions ran against an empty main frame (0/10 fields on Lyft) while
// findSubmitOnPage correctly found the real submit button inside the iframe —
// so auto-submit proceeded to click submit on a form it never actually filled,
// producing a stalled 'unconfirmed' result instead of a clean 'blocked'
// (no-submit-button) or a real success.
//
// Fix: probe each ATS's most reliable "form is present" selector on the main
// frame first (zero behavior change for the common non-iframe case — this is
// how every fill call already worked), then poll child frames for up to ~5s
// (Greenhouse embeds lazy-load ~3.5s, same timing findSubmitOnPage allows for)
// and fill whichever frame actually has the form fields.

const FORM_PROBE_SELECTORS = {
  greenhouse: 'input[autocomplete="given-name"], input[name="first_name"], input[id*="first"]',
  lever:      'input[name="name"], input[autocomplete="name"]',
  workday:    '[data-automation-id="legalNameSection_firstName"], input[aria-label*="First Name" i]',
  ashby:      '#_systemfield_name, input[name="_systemfield_name"]',
  generic:    'input[autocomplete="given-name"], input[autocomplete="email"], input[type="email"]',
};

async function frameHasForm(frame, ats) {
  const sel = FORM_PROBE_SELECTORS[ats] || FORM_PROBE_SELECTORS.generic;
  try {
    return (await frame.locator(sel).count()) > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve which frame (main page, or a child <iframe>) actually contains the
 * application form fields, so fillForm() fills the right target.
 *
 * Mirrors auto-submit.mjs's findSubmitOnPage(): main frame is checked first
 * (unchanged behavior for the ~99% non-iframe case), then child frames are
 * polled every 400ms for up to ~5s to survive lazy-loaded embeds. Falls back
 * to the main page/frame if no frame ever has the form, so existing
 * missing_fields reporting (and auto-submit.mjs's B-16 empty-form guard) keep
 * working exactly as before for genuinely form-less/broken pages.
 *
 * @param {import('playwright').Page} page
 * @param {string} ats
 * @returns {Promise<import('playwright').Page|import('playwright').Frame>}
 */
export async function findFormFrame(page, ats) {
  // Mock/test pages (no mainFrame/frames support) — behave exactly as before.
  if (typeof page.mainFrame !== 'function' || typeof page.frames !== 'function') {
    return page;
  }

  if (await frameHasForm(page.mainFrame(), ats)) return page;

  const deadline = Date.now() + 5000;
  do {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await frameHasForm(frame, ats)) return frame;
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);

  return page;
}

// ── ATS dispatcher ────────────────────────────────────────────────────────────

export async function fillForm(ats, page, personal, clPath = null) {
  const target = await findFormFrame(page, ats);
  switch (ats) {
    case 'greenhouse': return fillGreenhouseForm(target, personal, clPath);
    case 'lever':      return fillLeverForm(target, personal, clPath);
    case 'workday':    return fillWorkdayForm(target, personal, clPath);
    case 'ashby':      return fillAshbyForm(target, personal, clPath);
    default:           return fillGenericForm(target, personal, clPath);
  }
}

// ── Internal runner ───────────────────────────────────────────────────────────

async function _runFields(fields, ats) {
  const missing_fields = [];
  const upload_details = {};
  let filled = 0;

  for (const { name, fn, type, key } of fields) {
    const result = await fn();
    if (type === 'upload') {
      upload_details[key] = result;
      if (result.uploaded) {
        filled++;
      } else {
        missing_fields.push(name);
      }
    } else {
      if (result) {
        filled++;
      } else {
        missing_fields.push(name);
      }
    }
  }

  return { filled, total: fields.length, missing_fields, upload_details, ats };
}
