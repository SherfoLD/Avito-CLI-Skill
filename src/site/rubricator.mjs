/**
 * The category sidebar, `rubricators.side.nodes`: what a node is, what its type
 * means, and the one walk over the tree both commands that read it share
 * (D-046). `get-categories` and `move-category` differ in what they do with a
 * node, not in what a node is.
 *
 * Avito's vocabulary for `type`, which no command may hold a second opinion
 * about:
 *
 *   0  a branch — a group head, drawn with an expander arrow and never as a
 *      link, whose own route Avito still hands over (F-083)
 *   1  an option — the nodes the page draws as anchors
 *   2  the current category — where this search already is
 *
 * An unknown type stops the walk, because a fourth kind of node is a sidebar
 * neither command can describe.
 */

import { CommandExecutionError } from '../runtime/errors.mjs';
import { decode } from '../runtime/schema.mjs';
import { SIDEBAR_NODE } from '../schemas/rubricator.mjs';
import { answeredUrl } from './url.mjs';

/** The deepest nesting a sidebar may claim, and the most nodes it may carry. */
export const MAX_DEPTH = 20;
const MAX_SIDE_NODES = 200;

export function sidebarRole(type) {
  if (type === 0) return 'branch';
  if (type === 1) return 'option';
  if (type === 2) return 'current';
  return null;
}

/**
 * Every node of the tree in the order Avito drew it, each with the three things
 * a caller needs that the node itself does not carry: how deep it sits, the
 * visible name it hangs under, and its route as a `URL` — `null` where Avito
 * hung none, which is a node that cannot be followed rather than a sidebar this
 * CLI fails to understand.
 */
export function sidebarWalk(rawNodes, baseUrl) {
  if (!Array.isArray(rawNodes)) {
    throw new CommandExecutionError('Avito category sidebar has an unexpected shape');
  }

  const entries = [];
  const seenIds = new Set();
  const visit = (nodes, depth, parent) => {
    if (depth > MAX_DEPTH) {
      throw new CommandExecutionError('Avito category sidebar exceeds its supported nesting depth');
    }
    for (const rawNode of nodes) {
      if (entries.length >= MAX_SIDE_NODES) {
        throw new CommandExecutionError('Avito category sidebar contains implausibly many nodes');
      }
      const node = decode(
        SIDEBAR_NODE,
        rawNode,
        `Avito category sidebar node at position ${entries.length + 1}`,
      );
      const role = sidebarRole(node.type);
      if (role === null) {
        throw new CommandExecutionError(`Avito category sidebar node "${node.name}" has an unsupported type`);
      }
      if (seenIds.has(node.id)) {
        throw new CommandExecutionError(`Avito category sidebar repeats node ID ${node.id}`);
      }
      seenIds.add(node.id);

      const route = String(node.url ?? '').trim() === ''
        ? null
        : answeredUrl(node.url, `category sidebar route of node ${node.id}`, baseUrl.href);
      entries.push({ node, depth, parent, role, route });
      visit(node.children, depth + 1, node.name);
    }
  };
  visit(rawNodes, 0, null);

  return entries;
}

/**
 * The category this search is in, by the one node Avito marks as current, or
 * `null` where it marks none — a search it could place nowhere, drawn as several
 * current branches instead (F-084). That `null` is the answer, not a missing
 * one: the sidebar itself is refused by `sidebarWalk` before this is asked.
 *
 * Two current categories is not a choice to make quietly. Avito has never drawn
 * one, and the day it does, picking the first would name a category the search
 * is not in.
 */
export function currentCategoryName(entries) {
  const current = entries.filter((entry) => entry.role === 'current');
  if (current.length > 1) {
    throw new CommandExecutionError('Avito category sidebar marks more than one current category');
  }
  return current.length === 1 ? current[0].node.name : null;
}

/**
 * Whether a node's route is one this search can be moved to — the URL decides,
 * not what the page draws (D-057). Two nodes are not a move: the node Avito
 * itself marks as the current category, and any node whose route is the one
 * already requested. The second comparison is by pathname alone, because the
 * sidebar's copy of a route carries a `cd=1` the request did not — and it is
 * the one already requested, not the one Avito would canonicalise it to, so the
 * role is still asked as well.
 */
export function isFollowableNode(role, route, currentPathname) {
  if (role === 'current') return false;
  return route != null && route.pathname !== currentPathname;
}
