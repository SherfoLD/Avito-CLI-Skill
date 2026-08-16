/**
 * Avito's vocabulary for a node of the category sidebar
 * (`rubricators.side.nodes`), which no command may hold a second opinion about:
 *
 *   0  an expanded branch — an arrow row that opens its children and carries no
 *      navigation URL of its own
 *   1  an option — the only kind that carries a route you can follow
 *   2  the current category — where this search already is
 *
 * An unknown type is `null` rather than a guess, so each caller refuses a
 * fourth kind of node in the terms its own caller can act on.
 */

export function sidebarRole(type) {
  if (type === 0) return 'expanded';
  if (type === 1) return 'option';
  if (type === 2) return 'current';
  return null;
}

/**
 * An expanded branch and the current row are never followed even when the
 * bootstrap hides a URL on them: the first is a control, the second is where
 * the search already is.
 */
export function isNavigableSidebarNode(type) {
  return sidebarRole(type) === 'option';
}
