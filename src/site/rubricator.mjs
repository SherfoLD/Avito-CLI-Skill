/**
 * Avito's vocabulary for a node of the category sidebar
 * (`rubricators.side.nodes`), which no command may hold a second opinion about:
 *
 *   0  a branch — a group head, drawn with an expander arrow and never as a
 *      link, whose own route Avito still hands over (F-083)
 *   1  an option — the rows the page draws as anchors
 *   2  the current category — where this search already is
 *
 * An unknown type is `null` rather than a guess, so each caller refuses a
 * fourth kind of node in the terms its own caller can act on.
 */

export function sidebarRole(type) {
  if (type === 0) return 'branch';
  if (type === 1) return 'option';
  if (type === 2) return 'current';
  return null;
}

/**
 * Whether a node's route is one this search can be moved to — the URL decides,
 * not what the page draws (D-057). Two rows are not a move: the node Avito
 * itself marks as the current category, and any node whose route is the one
 * already requested. The second comparison is by pathname alone, because the
 * sidebar's copy of a route carries a `cd=1` the request did not — and it is
 * the one already requested, not the one Avito would canonicalise it to, so the
 * type is still asked as well.
 */
export function isFollowableNode(type, targetUrl, currentPathname) {
  if (sidebarRole(type) === 'current') return false;
  return targetUrl != null && targetUrl.pathname !== currentPathname;
}
