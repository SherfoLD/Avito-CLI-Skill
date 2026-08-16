/**
 * Convention audit — static rules over `src/`.
 *
 * These are the constraints that are cheap to state and expensive to remember:
 * every one of them exists because a command once returned plausible data that
 * was quietly wrong. The audit reads source text, so it catches the shape of a
 * mistake, not its effect; the offline suites and the verify fixtures catch the
 * rest.
 *
 * Rules, and what each one is actually defending:
 *
 *   missing-access-metadata     a command that does not say whether it reads or
 *                               writes cannot be reviewed as read-only.
 *   column-naming               row keys are the agent-facing API. They are
 *                               camelCase here and the order is pinned by the
 *                               verify fixtures; a snake_case key means two
 *                               conventions now exist and callers must guess.
 *   silent-column-drop          a row literal emits a key the descriptor never
 *                               declares, so `--help` and the table disagree and
 *                               the value disappears from tabular output.
 *   silent-clamp                an out-of-range argument gets bent into range
 *                               instead of refused, so the caller believes they
 *                               asked for something they did not.
 *   silent-empty-fallback       `return []` inside a catch turns a failed fetch
 *                               into "Avito has nothing", which is a lie the
 *                               caller cannot detect.
 *   silent-sentinel             `?? 'unknown'` turns missing data into fake data.
 *   hardcoded-site-vocabulary   region, category, filter and photo-size
 *                               identifiers belong to Avito. Pinning one in
 *                               code means the day Avito renumbers it the
 *                               command keeps answering, with the wrong subject.
 *   write-without-delete-pair   a write command with no undo strands remote
 *                               state the caller cannot walk back.
 *
 * An intentional exception to `hardcoded-site-vocabulary` is written in the
 * source, not in a baseline file: put `// vocabulary-ok: <reason>` on the line
 * or the line above. Nothing else here has an inline escape hatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PROJECT_ROOT, relativeToRoot } from './paths.mjs';
import { loadManifest } from './manifest.mjs';

export const HARD_RULES = [
  'missing-access-metadata',
  'column-naming',
  'hardcoded-site-vocabulary',
  'write-without-delete-pair',
];

export const BASELINED_RULES = [
  'silent-column-drop',
  'silent-clamp',
  'silent-empty-fallback',
  'silent-sentinel',
];

export const RULES = [...HARD_RULES, ...BASELINED_RULES];

const COLUMN_DROP_IGNORED_KEYS = new Set(['ok', 'error']);

const WRITE_PAIR_RULES = [
  { match: /(^|[-_])favorite($|[-_])/, describe: 'favorite', expected: (name) => [name.replace(/favorite/g, 'unfavorite'), 'unfavorite', 'remove-favorite'] },
  { match: /(^|[-_])add($|[-_])/, describe: 'add', expected: (name) => [name.replace(/add/g, 'remove'), 'remove', 'delete'] },
  { match: /(^|[-_])create($|[-_])/, describe: 'create', expected: (name) => [name.replace(/create/g, 'delete'), name.replace(/create/g, 'remove'), 'delete', 'remove'] },
  { match: /(^|[-_])save($|[-_])/, describe: 'save', expected: (name) => [name.replace(/save/g, 'unsave'), 'unsave', 'delete', 'remove'] },
  { match: /(^|[-_])subscribe($|[-_])/, describe: 'subscribe', expected: (name) => [name.replace(/subscribe/g, 'unsubscribe'), 'unsubscribe'] },
];

/** Numbers this long are Avito's identifiers, not ours. */
const SITE_ID_LITERAL = /(?<![\w.])\d{6,}(?![\w.])/g;
/** `636x636`, `1280x960` — a photo variant key. Naming one pins a size Avito owns. */
const PHOTO_SIZE_LITERAL = /['"`]\s*\d{2,4}\s*x\s*\d{2,4}\s*['"`]/g;
/** A filter key written out in full. */
const PARAM_KEY_LITERAL = /params\[\s*\d+\s*\]/g;
/** Lines where a long number is a duration or a ceiling, not an Avito identifier. */
const NUMERIC_CONTEXT = /timeout|_?ms\b|millis|delay|interval|backoff|budget|ceiling|max[A-Z_]|MAX_|limit|epoch|timestamp/i;
const VOCABULARY_ESCAPE = /vocabulary-ok\s*:/;

export async function runConventionAudit({ target } = {}) {
  const manifest = (await loadManifest()).filter((entry) => matchesTarget(entry, target));
  const violations = [];
  const sourceCache = new Map();
  const scannedFiles = new Set();

  for (const entry of manifest) {
    const command = { site: entry.site, name: entry.name, command: `${entry.site}/${entry.name}` };

    if (entry.access !== 'read' && entry.access !== 'write') {
      violations.push({
        rule: 'missing-access-metadata',
        ...command,
        message: `${command.command} must declare access: 'read' | 'write'`,
      });
    }

    for (const column of entry.columns) {
      const problem = columnNamingProblem(column);
      if (problem) {
        violations.push({
          rule: 'column-naming',
          ...command,
          message: `${command.command} column "${column}" ${problem}`,
          details: { column },
        });
      }
    }

    for (const sourcePath of sourcesForCommand(entry)) {
      const source = readSource(sourcePath, sourceCache);
      if (source == null) continue;
      scannedFiles.add(sourcePath);
      violations.push(...auditColumnDrop(command, entry.columns, source, sourcePath));
    }
  }

  // Line rules run over every source file, command or not: a decoder that
  // invents an "unknown" seller is exactly as wrong as a command that does.
  for (const sourcePath of allSourceFiles()) {
    const source = readSource(sourcePath, sourceCache);
    if (source == null) continue;
    scannedFiles.add(sourcePath);
    const owner = ownerForFile(sourcePath, manifest);
    violations.push(...auditLineRules(owner, source, sourcePath));
  }

  violations.push(...auditWriteDeletePair(manifest));

  const categories = RULES.map((rule) => {
    const items = violations.filter((violation) => violation.rule === rule);
    return { rule, count: items.length, violations: items };
  });

  return {
    ok: violations.length === 0,
    summary: {
      commands: manifest.length,
      files_scanned: scannedFiles.size,
      violations: violations.length,
    },
    categories,
  };
}

export function renderConventionAuditText(report) {
  const lines = [];
  lines.push('Convention audit');
  lines.push(`Scanned ${report.summary.commands} command(s), ${report.summary.files_scanned} source file(s).`);
  lines.push(`Violations: ${report.summary.violations}`);
  lines.push('');
  for (const category of report.categories) {
    const gate = HARD_RULES.includes(category.rule) ? 'gate' : 'baselined';
    lines.push(`${category.rule} [${gate}]: ${category.count === 0 ? 'OK' : category.count}`);
    for (const violation of category.violations) {
      const where = violation.file ? ` (${violation.file}${violation.line ? `:${violation.line}` : ''})` : '';
      lines.push(`  - ${violation.command ?? '(no command)'}${where}`);
      lines.push(`    ${violation.message}`);
      if (violation.details?.text) lines.push(`    ${violation.details.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── rules ────────────────────────────────────────────────────────────────────

function columnNamingProblem(column) {
  if (typeof column !== 'string' || column.trim() === '') return 'is not a name';
  if (column.includes('_')) return 'uses snake_case; row keys in this repository are camelCase';
  if (column.includes('-')) return 'uses kebab-case; row keys in this repository are camelCase';
  if (!/^[a-z][A-Za-z0-9]*$/.test(column)) return 'is not camelCase';
  return null;
}

function auditColumnDrop(command, columns, source, sourcePath) {
  const declared = new Set(columns);
  if (declared.size === 0) return [];
  const transformedIntermediateKeys = findTransformedIntermediateKeys(source, declared);
  const seen = new Set();
  const violations = [];

  for (const object of extractPotentialRowObjects(source)) {
    if (isFailureDiagnosticObject(object.text)) continue;
    const keys = extractObjectKeys(object.text).filter((key) => !COLUMN_DROP_IGNORED_KEYS.has(key));
    if (keys.length < 2) continue;
    if (looksLikeCommandDescriptor(keys)) continue;
    const overlap = keys.filter((key) => declared.has(key));
    if (overlap.length === 0) continue;
    const missing = keys.filter((key) => !declared.has(key) && !transformedIntermediateKeys.has(key));
    if (missing.length === 0) continue;
    const signature = [...missing].sort().join(',');
    if (seen.has(signature)) continue;
    seen.add(signature);
    violations.push({
      rule: 'silent-column-drop',
      ...command,
      file: relativeToRoot(sourcePath),
      line: lineForIndex(source, object.index),
      message: `${command.command} emits row key(s) absent from columns: ${missing.join(', ')}`,
      details: { emitted_keys: keys, columns: [...declared], missing },
    });
  }
  return violations;
}

function auditLineRules(owner, source, sourcePath) {
  const violations = [];
  const file = relativeToRoot(sourcePath);
  const lines = source.split(/\r?\n/);
  const code = stripComments(lines);
  const catchRanges = findCatchBlockRanges(source);
  let offset = 0;

  lines.forEach((line, index) => {
    const stripped = code[index];

    if (/Math\.(?:min|max)\s*\(/.test(stripped) && /\b(?:limit|page|offset|count|radius|perPage)\b/i.test(stripped)) {
      violations.push({
        rule: 'silent-clamp',
        ...owner,
        file,
        line: index + 1,
        message: 'an argument is clamped instead of refused; validate it and throw ArgumentError',
        details: { text: line.trim() },
      });
    }

    const emptyReturnIndex = stripped.search(/\breturn\s+\[\s*\]\s*;?/);
    if (emptyReturnIndex >= 0 && isInsideAnyRange(offset + emptyReturnIndex, catchRanges)) {
      violations.push({
        rule: 'silent-empty-fallback',
        ...owner,
        file,
        line: index + 1,
        message: 'an empty array inside catch hides a fetch or parse failure; throw a typed error instead',
        details: { text: line.trim() },
      });
    }

    const sentinel = /(?:\?\?|\|\|)\s*(['"`])(unknown|Unknown|UNKNOWN|N\/A|n\/a|NA|-|неизвестно|Неизвестно|нет данных)\1/.exec(stripped);
    if (sentinel && !/\bthrow\s+new\b/.test(stripped)) {
      violations.push({
        rule: 'silent-sentinel',
        ...owner,
        file,
        line: index + 1,
        message: `sentinel fallback ${sentinel[0].trim()} turns missing data into fake data; drop the field or throw`,
        details: { text: line.trim() },
      });
    }

    violations.push(...auditVocabularyLine(owner, file, lines, code, index));

    offset += line.length + 1;
  });

  return dedupeViolations(violations);
}

function auditVocabularyLine(owner, file, lines, code, index) {
  const line = lines[index];
  const previous = index > 0 ? lines[index - 1] : '';
  if (VOCABULARY_ESCAPE.test(line) || VOCABULARY_ESCAPE.test(previous)) return [];

  const stripped = code[index];
  const found = [];

  for (const match of stripped.matchAll(PARAM_KEY_LITERAL)) found.push(match[0]);
  for (const match of stripped.matchAll(PHOTO_SIZE_LITERAL)) found.push(match[0]);
  if (!NUMERIC_CONTEXT.test(stripped)) {
    for (const match of stripped.matchAll(SITE_ID_LITERAL)) found.push(match[0]);
  }
  if (found.length === 0) return [];

  return [{
    rule: 'hardcoded-site-vocabulary',
    ...owner,
    file,
    line: index + 1,
    message: `literal(s) ${[...new Set(found)].join(', ')} name Avito's own vocabulary; read them from the live response instead`,
    details: { text: line.trim() },
  }];
}

function auditWriteDeletePair(manifest) {
  const names = new Set(manifest.map((entry) => entry.name));
  const violations = [];
  for (const entry of manifest) {
    if (entry.access !== 'write') continue;
    const pair = WRITE_PAIR_RULES.find((rule) => rule.match.test(entry.name));
    if (!pair) continue;
    const expected = [...new Set(pair.expected(entry.name).filter((name) => name !== entry.name))];
    if (expected.some((name) => names.has(name))) continue;
    violations.push({
      rule: 'write-without-delete-pair',
      site: entry.site,
      name: entry.name,
      command: `${entry.site}/${entry.name}`,
      message: `write command "${entry.name}" looks like ${pair.describe} but nothing undoes it`,
      details: { expected_any_of: expected },
    });
  }
  return violations;
}

// ── source helpers ───────────────────────────────────────────────────────────

function allSourceFiles() {
  const roots = [path.join(PROJECT_ROOT, 'src')];
  const files = [];
  while (roots.length > 0) {
    const dir = roots.pop();
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) roots.push(full);
      else if (entry.name.endsWith('.mjs') && !entry.name.includes('.test.')) files.push(full);
    }
  }
  return files.sort();
}

function sourcesForCommand(entry) {
  const candidates = [entry.sourcePath, path.join(PROJECT_ROOT, 'src', 'decoders', `${entry.name}.mjs`)];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function ownerForFile(sourcePath, manifest) {
  const owner = manifest.find((entry) => entry.sourcePath === sourcePath);
  if (owner) return { site: owner.site, name: owner.name, command: `${owner.site}/${owner.name}` };
  const base = path.basename(sourcePath, '.mjs');
  const byName = manifest.find((entry) => entry.name === base);
  if (byName) return { site: byName.site, name: byName.name, command: `${byName.site}/${byName.name}` };
  return { site: 'avito', name: base, command: relativeToRoot(sourcePath) };
}

function readSource(sourcePath, cache) {
  if (cache.has(sourcePath)) return cache.get(sourcePath);
  try {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    cache.set(sourcePath, source);
    return source;
  } catch {
    cache.set(sourcePath, null);
    return null;
  }
}

function matchesTarget(entry, target) {
  const wanted = target?.trim();
  if (!wanted) return true;
  if (wanted.includes('/')) return `${entry.site}/${entry.name}` === wanted;
  return entry.name === wanted || entry.site === wanted;
}

/**
 * Blank out comments so a rule never fires on prose. The doc comments in this
 * repository quote example arguments and example failures on purpose, and a
 * linter that reads them as code makes writing an explanation dangerous.
 *
 * This is a line scanner, not a parser: it tracks `/* … *\/` across lines and
 * drops a trailing `//` when it is not inside a string.
 */
function stripComments(lines) {
  let inBlock = false;
  return lines.map((line) => {
    let result = '';
    let index = 0;
    let quote = null;
    while (index < line.length) {
      const two = line.slice(index, index + 2);
      if (inBlock) {
        if (two === '*/') { inBlock = false; index += 2; } else index += 1;
        continue;
      }
      if (quote) {
        result += line[index];
        if (line[index] === '\\') { result += line[index + 1] ?? ''; index += 2; continue; }
        if (line[index] === quote) quote = null;
        index += 1;
        continue;
      }
      if (two === '/*') { inBlock = true; index += 2; continue; }
      if (two === '//') break;
      const ch = line[index];
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      result += ch;
      index += 1;
    }
    return result;
  });
}

function extractPotentialRowObjects(source) {
  const objects = [];
  const triggers = [/\.push\s*\(\s*{/g, /\breturn\s+(?:\(\s*)?{/g, /=>\s*\(\s*{/g];
  for (const trigger of triggers) {
    for (const match of source.matchAll(trigger)) {
      const token = match[0];
      const openOffset = token.lastIndexOf('{');
      if (match.index === undefined || openOffset < 0) continue;
      const index = match.index + openOffset;
      const text = readBalancedBlock(source, index);
      if (text) objects.push({ text, index });
    }
  }
  return objects;
}

function findCatchBlockRanges(source) {
  const ranges = [];
  for (const match of source.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*{/g)) {
    if (match.index === undefined) continue;
    const openIndex = match.index + match[0].lastIndexOf('{');
    const end = findBalancedBlockEnd(source, openIndex);
    if (end >= 0) ranges.push({ start: openIndex, end });
  }
  return ranges;
}

function findBalancedBlockEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function isInsideAnyRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

function readBalancedBlock(source, openIndex) {
  const end = findBalancedBlockEnd(source, openIndex);
  return end >= 0 ? source.slice(openIndex, end + 1) : null;
}

function extractObjectKeys(objectText) {
  return [...new Set(extractObjectProperties(objectText).map((property) => property.key))];
}

function extractObjectProperties(objectText) {
  const body = objectText.trim().replace(/^\{/, '').replace(/\}$/, '');
  return splitTopLevel(body, ',').map(extractProperty).filter(Boolean);
}

function extractProperty(part) {
  const trimmed = part.trim();
  if (!trimmed || trimmed.startsWith('...') || trimmed.startsWith('[')) return null;
  const colonIndex = findTopLevelChar(trimmed, ':');
  if (colonIndex >= 0) {
    const raw = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (/^['"][^'"]+['"]$/.test(raw)) return { key: raw.slice(1, -1), value };
    const identifier = /^([A-Za-z_$][\w$]*)$/.exec(raw);
    return identifier ? { key: identifier[1], value } : null;
  }
  const shorthand = /^([A-Za-z_$][\w$]*)\b/.exec(trimmed);
  return shorthand ? { key: shorthand[1], value: shorthand[1] } : null;
}

function isFailureDiagnosticObject(objectText) {
  const ok = extractObjectProperties(objectText).find((property) => property.key === 'ok');
  if (ok != null && /^false\b/.test(ok.value)) return true;
  const success = extractObjectProperties(objectText).find((property) => property.key === 'success');
  return success != null && /^false\b/.test(success.value);
}

function looksLikeCommandDescriptor(keys) {
  const set = new Set(keys);
  return set.has('columns') || (set.has('name') && (set.has('description') || set.has('access')));
}

function findTransformedIntermediateKeys(source, columns) {
  const transformed = new Set();
  for (const match of source.matchAll(/=>\s*\(\s*{/g)) {
    const openOffset = match[0].lastIndexOf('{');
    if (match.index === undefined || openOffset < 0) continue;
    const text = readBalancedBlock(source, match.index + openOffset);
    if (!text) continue;
    for (const property of extractObjectProperties(text)) {
      if (!columns.has(property.key)) continue;
      for (const inner of property.value.matchAll(/\b([A-Za-z_$][\w$]*(?:Raw|Class|Node|Source))\b/g)) {
        if (inner[1] !== property.key) transformed.add(inner[1]);
      }
    }
  }
  return transformed;
}

function splitTopLevel(input, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (depth === 0 && ch === separator) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function findTopLevelChar(input, target) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (depth === 0 && ch === target) return i;
  }
  return -1;
}

function lineForIndex(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function dedupeViolations(violations) {
  const seen = new Set();
  return violations.filter((violation) => {
    const key = `${violation.rule}:${violation.command}:${violation.file}:${violation.line}:${violation.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
