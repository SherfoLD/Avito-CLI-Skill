/**
 * The shape of the filter tree Avito ships in `filtersV2`, never the meaning of
 * a value. Which types are ranges, which take several values, which serialize
 * bare — that vocabulary belongs to the command applying them.
 */

/**
 * Every filter in the tree, flattened depth-first.
 *
 * A tree deeper than ten levels or wider than `maxFilters` is not a big search
 * page; it is a response that has stopped being a filter tree, and walking it
 * further would be guessing.
 */
export function flattenFilters(sections, maxFilters) {
  const result = [];
  const visit = (filter, depth = 0) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) || depth > 10) {
      throw new Error('malformed filter tree');
    }
    result.push(filter);
    if (result.length > maxFilters) throw new Error('implausible filter count');
    if (filter.content != null && !Array.isArray(filter.content)) {
      throw new Error('malformed filter content');
    }
    for (const child of filter.content || []) visit(child, depth + 1);
  };
  for (const section of sections) {
    if (!section || typeof section !== 'object' || !Array.isArray(section.Filters)) {
      throw new Error('malformed filter section');
    }
    for (const filter of section.Filters) visit(filter);
  }
  return result;
}

/**
 * The options of one filter, whatever grouping Avito drew around them.
 *
 * `values` is either a flat option list or a list of wrappers carrying `id`,
 * `title` and `options` — the named groups of one visible control. A wrapper
 * holds no value a caller can apply, so its options are taken and it is
 * dropped. Avito repeats a popular option in more than one group, so a repeat
 * is one option, not an ambiguity.
 *
 * Returns `null` when the two forms are mixed in one array: that is drift, and
 * the caller must refuse rather than pick a reading (F-060).
 */
export function filterOptions(filter) {
  const declared = Array.isArray(filter?.values) ? filter.values : [];
  const sections = declared.filter((entry) => entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && Array.isArray(entry.options));
  if (sections.length === 0) return declared;
  if (sections.length !== declared.length) return null;
  const flattened = [];
  for (const section of sections) flattened.push(...section.options);
  return flattened;
}
