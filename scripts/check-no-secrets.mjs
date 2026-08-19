#!/usr/bin/env node
/**
 * check-no-secrets.mjs — nothing session-bound enters the repository.
 *
 * Evidence samples are recorded from a real logged-in browser, so the shortest
 * path from "I captured a response" to "a cookie is in git history" is one
 * careless copy. This scans everything that is committed — evidence samples,
 * expectations, docs, source — for the shapes of a credential.
 *
 * It cannot prove absence; it catches the mistake that actually happens. Trace
 * dumps are the other half of the same rule and are handled by .gitignore,
 * because they are too large and too raw to review by eye.
 *
 * Usage: node scripts/check-no-secrets.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PROJECT_ROOT, relativeToRoot } from './lib/paths.mjs';

const SCAN_DIRS = ['evidence', 'expectations', 'docs', 'src', 'tests', 'scripts', 'skills'];
const SCAN_EXTENSIONS = new Set(['.json', '.md', '.mjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'traces', '.git']);

const PATTERNS = [
  { name: 'cookie header', re: /["'`]?(?:set-)?cookie["'`]?\s*[:=]\s*["'`][^"'`]{16,}/i },
  { name: 'authorization header', re: /["'`]?authorization["'`]?\s*[:=]\s*["'`][^"'`]{8,}/i },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: 'json web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'session identifier', re: /\b(?:sessid|session_id|sessionId|PHPSESSID|_csrf|csrfToken)\b\s*[:=]\s*["'`][^"'`]{8,}/i },
  { name: 'api key', re: /\b(?:api[_-]?key|secret|password|passwd)\b\s*[:=]\s*["'`][^"'`]{8,}/i },
];

const findings = [];

for (const dir of SCAN_DIRS) {
  const full = path.join(PROJECT_ROOT, dir);
  // A directory that was renamed away is scanned by nothing, which looks exactly
  // like a directory with no secrets in it.
  if (!fs.existsSync(full)) {
    console.error(`${dir}/ is named here and does not exist — this check is scanning less than it claims.`);
    process.exit(1);
  }
  walk(full);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
    scan(full);
  }
}

function scan(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) {
        findings.push({
          file: relativeToRoot(file),
          line: index + 1,
          name: pattern.name,
          text: line.trim().slice(0, 160),
        });
      }
    }
  });
}

console.log(`Secret scan: ${findings.length} finding(s).`);

if (findings.length === 0) {
  console.log('OK - nothing that looks session-bound is committed.');
  process.exit(0);
}

for (const finding of findings) {
  console.log(`  FAIL  ${finding.file}:${finding.line}  ${finding.name}`);
  console.log(`        ${finding.text}`);
}
console.log('\nStrip the value before committing. If a match is a false positive, narrow the capture rather than widening this scanner.');
process.exit(1);
