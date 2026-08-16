/**
 * Scalar and query-parameter handling shared by every browser half.
 *
 * Nothing here knows about listings. What it knows is how Avito's own state
 * objects compare: a value that arrives as a number on one carrier and as a
 * string on the other is the same value, a one-element array is the same as the
 * bare scalar, and a range is an object that must never be flattened.
 */

export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function comparableText(value) {
  return cleanText(value).toLocaleLowerCase('ru-RU');
}

export function normalizeScalar(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function normalizeValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeScalar).filter((entry) => entry != null);
}

/**
 * Avito is free to send back what it was sent in another form — `1` for `'1'`,
 * `['5']` for `'5'` — so a preserved field is compared as an unordered set of
 * stringified scalars. Anything stricter would report drift on every request.
 */
export function sameValues(left, right) {
  const a = normalizeValues(left).sort();
  const b = normalizeValues(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isRange(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A range applied to a route arrives as `{from, to}` on both carriers, with 0,
 * null or an empty string standing for the bound nobody set (F-063).
 */
export function rangeBound(value) {
  const scalar = normalizeScalar(value);
  return scalar == null || scalar === '' || scalar === '0' ? null : scalar;
}

/**
 * A cleared filter comes back either absent or carrying the value Avito uses
 * for "no restriction". Anything else means the clear did not happen.
 *
 * A range says it with its own shape, which is why it is asked separately:
 * flattened, every range would have looked cleared whatever it carried.
 */
export function isCleared(value) {
  if (isRange(value)) {
    return Object.values(value).every((entry) => rangeBound(entry) === null);
  }
  const values = normalizeValues(value);
  if (values.length === 0) return true;
  return values.every((entry) => entry === '' || entry === '0' || entry === 'false');
}

/** A carrier's range against the two bounds that were requested. */
export function sameRange(carrier, from, to) {
  return isRange(carrier)
    && rangeBound(carrier.from) === from
    && rangeBound(carrier.to) === to;
}

/**
 * Ranges are compared as objects. Flattened, every range would have compared
 * equal to every other one, and a filter Avito quietly dropped would have
 * looked preserved.
 */
export function sameParamValue(left, right) {
  if (isRange(left) || isRange(right)) {
    return isRange(left) && isRange(right)
      && rangeBound(left.from) === rangeBound(right.from)
      && rangeBound(left.to) === rangeBound(right.to);
  }
  return sameValues(left, right);
}

export function addScalar(url, key, value) {
  if (value == null || value === '') return;
  const scalar = normalizeScalar(value);
  if (scalar == null) throw new Error('unsupported scalar for ' + key);
  url.searchParams.set(key, scalar);
}

/**
 * Carry one `params[...]` entry onto a request URL in the two shapes Avito's
 * own inputs declare: a range in `[from]`/`[to]`, a multi-select in `[0]`,
 * `[1]`, … and a single value bare.
 */
export function addParamValues(url, attrId, value, maxValues) {
  if (!/^\d+$/.test(attrId)) throw new Error('malformed params key');
  if (isRange(value)) {
    for (const side of Object.keys(value)) {
      if (side !== 'from' && side !== 'to') throw new Error('malformed params range');
    }
    for (const side of ['from', 'to']) {
      const bound = rangeBound(value[side]);
      if (bound != null) url.searchParams.set('params[' + attrId + '][' + side + ']', bound);
    }
    return;
  }
  const values = normalizeValues(value);
  if (values.length === 0 || values.length > maxValues) {
    throw new Error('malformed params value list');
  }
  if (Array.isArray(value)) {
    values.forEach((entry, index) => url.searchParams.append('params[' + attrId + '][' + index + ']', entry));
  } else {
    url.searchParams.set('params[' + attrId + ']', values[0]);
  }
}
