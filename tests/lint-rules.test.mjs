// Offline checks for the four repository lint rules.
//
// `npx eslint .` reporting nothing is only good news if the rules can report
// something. Each rule is given the code it exists to refuse and the nearby code
// it must stay silent about — a rule that fires on honest code gets switched off.
import { Linter } from 'eslint';

import { runner } from './harness.mjs';
import avito from '../scripts/lib/eslint-rules.mjs';

const { check, assert, run } = runner();
const linter = new Linter();

function lint(rule, code) {
  return linter.verify(code, {
    plugins: { 'avito-cdp': avito },
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { [`avito-cdp/${rule}`]: 'error' },
  });
}

function refuses(rule, code, pattern) {
  const messages = lint(rule, code);
  assert(messages.length > 0, `${rule} said nothing about: ${code}`);
  assert(pattern.test(messages[0].message), `${rule} said: ${messages[0].message}`);
}

function allows(rule, code) {
  const messages = lint(rule, code);
  assert(messages.length === 0, `${rule} objected to honest code: ${messages[0]?.message}`);
}

check('no-silent-clamp refuses an argument bent into range', () => {
  refuses('no-silent-clamp', 'const page = Math.min(page, 50);', /bends "page" into range/);
  refuses('no-silent-clamp', 'const n = Math.max(1, limit);', /bends "limit" into range/);
  refuses('no-silent-clamp', 'f(Math.min(radius, MAX_RADIUS));', /bends "radius" into range/);

  // A ceiling applied to something the caller did not choose is arithmetic.
  allows('no-silent-clamp', 'const widest = Math.max(...areas);');
  allows('no-silent-clamp', 'const width = Math.max(column.length, header.length);');
  // And the correct shape of the same decision.
  allows('no-silent-clamp', 'if (limit > MAX) throw new ArgumentError("limit must be <= " + MAX);');
});

check('no-empty-catch-fallback refuses a failed fetch that reads as no data', () => {
  refuses(
    'no-empty-catch-fallback',
    'async function f() { try { return await g(); } catch { return []; } }',
    /hides a fetch or parse failure/,
  );
  refuses(
    'no-empty-catch-fallback',
    'function f() { try { g(); } catch (error) { if (error) { return []; } } }',
    /hides a fetch or parse failure/,
  );

  // An empty array that is a real answer, and a catch that fails closed.
  allows('no-empty-catch-fallback', 'function f(items) { if (items == null) return []; return items; }');
  allows('no-empty-catch-fallback', 'function f() { try { g(); } catch (error) { throw new CommandExecutionError(error.message); } }');
});

check('no-silent-sentinel refuses missing data wearing a plausible value', () => {
  refuses('no-silent-sentinel', 'const name = seller.name ?? "unknown";', /turns missing data into fake data/);
  refuses('no-silent-sentinel', 'const city = row.city || "неизвестно";', /turns missing data into fake data/);
  refuses('no-silent-sentinel', 'const label = value ?? "N/A";', /turns missing data into fake data/);

  // Null is how this repository says "Avito did not send it".
  allows('no-silent-sentinel', 'const name = cleanText(seller.name) || null;');
  allows('no-silent-sentinel', 'const title = raw.title ?? raw.name;');
});

check('no-site-vocabulary refuses an Avito identifier pinned in our source', () => {
  refuses('no-site-vocabulary', 'const MOSCOW = 637640;', /names Avito's own vocabulary/);
  refuses('no-site-vocabulary', 'const photo = image["636x636"];', /names Avito's own vocabulary/);
  refuses('no-site-vocabulary', 'const key = "params[112691]";', /names Avito's own vocabulary/);
  refuses('no-site-vocabulary', 'const url = `${base}?locationId=637640`;', /names Avito's own vocabulary/);

  // A number named for what it measures is ours.
  allows('no-site-vocabulary', 'const REQUEST_TIMEOUT_MS = 1200000;');
  allows('no-site-vocabulary', 'const MAX_TOTAL_OPTIONS = 40000;');
  // And the one escape hatch, for text that quotes an example on purpose.
  allows('no-site-vocabulary', 'const example = "avito search q --location-id 650400"; // vocabulary-ok: help text');
  allows('no-site-vocabulary', '// vocabulary-ok: sample argument in help text\nconst example = "params[112691]=757883";');
});

export default await run('lint rules — what a schema cannot say');
