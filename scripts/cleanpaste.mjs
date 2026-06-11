#!/usr/bin/env node
/**
 * cleanpaste.mjs -- ATS-safe Unicode normalization for AI-generated text.
 *
 * LLMs produce fancy Unicode that pastes badly into ATS web forms: curly
 * quotes, zero-width spaces, em-dashes, non-breaking spaces. This script
 * normalizes them to plain ASCII equivalents in place.
 *
 * Usage: node scripts/cleanpaste.mjs <file1> [file2 ...]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every pattern here uses \u escapes so the source file is pure ASCII
// and immune to editor / encoding corruption.

/** @param {string} text */
export function cleanpaste(text) {
  return text
    // Curly double quotes -> straight
    .replace(/[“”]/g, '"')
    // Curly single quotes / apostrophes -> straight
    .replace(/[‘’]/g, "'")
    // Zero-width chars: ZWSP, ZWNJ, ZWJ, BOM, WORD JOINER
    .replace(/[​‌‍﻿⁠]/g, '')
    // EM DASH: before capital letter -> ". <Capital>"; otherwise -> ", "
    .replace(/—\s*([A-Z])/g, '. $1')
    .replace(/—/g, ', ')
    // EN DASH -> hyphen-minus
    .replace(/–/g, '-')
    // NO-BREAK SPACE -> regular space
    .replace(/ /g, ' ')
    // HORIZONTAL ELLIPSIS -> three dots
    .replace(/…/g, '...');
}

const IS_CLI = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_CLI) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node scripts/cleanpaste.mjs <file1> [file2 ...]');
    process.exit(1);
  }
  let changed = 0;
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const original = readFileSync(abs, 'utf8');
    const cleaned  = cleanpaste(original);
    if (cleaned !== original) {
      writeFileSync(abs, cleaned, 'utf8');
      console.log(`[cleanpaste] cleaned:    ${file}`);
      changed++;
    } else {
      console.log(`[cleanpaste] no changes: ${file}`);
    }
  }
  console.log(`\n${files.length} file(s) checked, ${changed} updated.`);
}
