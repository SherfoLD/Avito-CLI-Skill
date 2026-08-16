/**
 * Code that succeeds while lying, and the one thing that is not ours to name.
 * None of these is visible in a value, which is why none of them is a schema.
 *
 *   no-silent-clamp          an out-of-range argument gets bent into range
 *                            instead of refused, so the caller believes they
 *                            asked for something they did not.
 *   no-empty-catch-fallback  `return []` inside a catch turns a failed fetch
 *                            into "Avito has nothing", which is a lie the caller
 *                            cannot detect.
 *   no-silent-sentinel       `?? 'unknown'` turns missing data into fake data.
 *   no-site-vocabulary       region, category, filter and photo-size identifiers
 *                            belong to Avito. Pinning one in code means the day
 *                            Avito renumbers it the command keeps answering,
 *                            with the wrong subject.
 *
 * `no-site-vocabulary` has the one escape hatch in this repository: put
 * `// vocabulary-ok: <reason>` on the line or the line above. It exists because
 * help text and error messages quote example arguments on purpose.
 */

/** Argument names whose value a caller chose, and which must therefore be refused, not bent. */
const CLAMPABLE = /^(?:limit|page|offset|count|radius|perPage|size|depth)$/i;

/** Values that mean "we did not find out" while looking like an answer. */
const SENTINELS = new Set([
  'unknown', 'Unknown', 'UNKNOWN',
  'n/a', 'N/A', 'NA',
  '-', '—',
  'неизвестно', 'Неизвестно', 'нет данных', 'не указано',
]);

/** Numbers this long are Avito's identifiers, not ours. */
const SITE_ID = /(?<![\w.])\d{6,}(?![\w.])/;
/** `636x636`, `1280x960` — a photo variant key. Naming one pins a size Avito owns. */
const PHOTO_SIZE = /\b\d{2,4}x\d{2,4}\b/;
/** A filter key written out in full. */
const PARAM_KEY = /params\[\s*\d+\s*\]/;
const VOCABULARY_ESCAPE = /vocabulary-ok\s*:/;

const noSilentClamp = {
  meta: {
    type: 'problem',
    docs: { description: 'refuse an out-of-range argument instead of clamping it' },
    schema: [],
    messages: {
      clamped: 'Math.{{method}} bends "{{name}}" into range instead of refusing it. Validate the argument and throw ArgumentError.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression'
          || callee.object.type !== 'Identifier'
          || callee.object.name !== 'Math'
          || callee.property.type !== 'Identifier'
          || (callee.property.name !== 'min' && callee.property.name !== 'max')
        ) return;

        const clamped = node.arguments.find(
          (argument) => argument.type === 'Identifier' && CLAMPABLE.test(argument.name),
        );
        if (!clamped) return;
        context.report({
          node,
          messageId: 'clamped',
          data: { method: callee.property.name, name: clamped.name },
        });
      },
    };
  },
};

const noEmptyCatchFallback = {
  meta: {
    type: 'problem',
    docs: { description: 'a failed fetch is a typed error, never an empty result' },
    schema: [],
    messages: {
      swallowed: 'An empty array returned from a catch hides a fetch or parse failure. Throw a typed error instead.',
    },
  },
  create(context) {
    return {
      ReturnStatement(node) {
        if (node.argument?.type !== 'ArrayExpression' || node.argument.elements.length > 0) return;
        const inCatch = context.sourceCode
          .getAncestors(node)
          .some((ancestor) => ancestor.type === 'CatchClause');
        if (inCatch) context.report({ node, messageId: 'swallowed' });
      },
    };
  },
};

const noSilentSentinel = {
  meta: {
    type: 'problem',
    docs: { description: 'missing data stays missing; it never becomes a plausible value' },
    schema: [],
    messages: {
      sentinel: 'Falling back to {{value}} turns missing data into fake data. Drop the field or throw.',
    },
  },
  create(context) {
    return {
      LogicalExpression(node) {
        if (node.operator !== '??' && node.operator !== '||') return;
        const right = node.right;
        if (right.type !== 'Literal' || typeof right.value !== 'string') return;
        if (!SENTINELS.has(right.value)) return;
        context.report({ node, messageId: 'sentinel', data: { value: right.raw } });
      },
    };
  },
};

const noSiteVocabulary = {
  meta: {
    type: 'problem',
    docs: { description: "Avito's identifiers are read from Avito, never pinned in our source" },
    schema: [],
    messages: {
      pinned: '{{found}} names Avito\'s own vocabulary. Read it from the live response, or explain the exception with "// vocabulary-ok: <reason>".',
    },
  },
  create(context) {
    const { sourceCode } = context;

    const excused = (node) => {
      const line = node.loc.start.line;
      return sourceCode.getAllComments().some((comment) => (
        VOCABULARY_ESCAPE.test(comment.value)
        && (comment.loc.end.line === line || comment.loc.end.line === line - 1)
      ));
    };

    const check = (node, subject) => {
      const found = [SITE_ID, PHOTO_SIZE, PARAM_KEY]
        .map((pattern) => pattern.exec(subject)?.[0])
        .filter(Boolean);
      if (found.length === 0 || excused(node)) return;
      context.report({ node, messageId: 'pinned', data: { found: found.join(', ') } });
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
        // A long number is an Avito ID unless the name it is bound to says
        // otherwise: a timeout, a ceiling and an epoch are all ours.
        else if (typeof node.value === 'number' && !isOurNumber(node)) check(node, String(node.raw));
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};

/** Named for what it measures rather than what it identifies. */
const OUR_NUMBER = /timeout|_?ms$|millis|delay|interval|backoff|budget|ceiling|max|min|limit|epoch|timestamp|stamp|size|length|seconds/i;

function isOurNumber(node) {
  const parent = node.parent;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return OUR_NUMBER.test(parent.id.name);
  }
  if (parent?.type === 'Property' && parent.key.type === 'Identifier') {
    return OUR_NUMBER.test(parent.key.name);
  }
  if (parent?.type === 'BinaryExpression' || parent?.type === 'AssignmentExpression') {
    const other = parent.left === node ? parent.right : parent.left;
    return other?.type === 'Identifier' && OUR_NUMBER.test(other.name);
  }
  return false;
}

export default {
  meta: { name: 'avito-cdp' },
  rules: {
    'no-silent-clamp': noSilentClamp,
    'no-empty-catch-fallback': noEmptyCatchFallback,
    'no-silent-sentinel': noSilentSentinel,
    'no-site-vocabulary': noSiteVocabulary,
  },
};
