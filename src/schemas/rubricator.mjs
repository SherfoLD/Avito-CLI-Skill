/**
 * A node of the category sidebar, `rubricators.side.nodes`.
 *
 * The part of a node that is a shape. What a node *means* — whether its type
 * and state agree, whether two nodes claim to be current, where its URL points
 * — is decided by whoever reads it, against `src/site/rubricator.mjs`.
 */

import { requiredText, z } from '../runtime/schema.mjs';

export const MAX_NAME_LENGTH = 300;

export const SIDEBAR_NODE = z.object({
  id: z.number().int().positive(),
  type: z.number().int(),
  name: requiredText().pipe(z.string().max(MAX_NAME_LENGTH)),
  children: z.array(z.unknown()),
  isCurrent: z.boolean(),
  isOpened: z.boolean(),
  hasBack: z.boolean(),
  url: z.unknown(),
});
