/**
 * `buyerItem` — what the listing page and the item API both answer with.
 *
 * Read with `safeParse` by `src/site/item.mjs`, never with `decode`: this
 * carrier has a second one behind it, and a shape the decoder cannot trust is
 * the same answer as a value it cannot trust — `null`, meaning "try the page".
 *
 * Declared here is the shape whose absence made the decoder return `null`
 * anyway. Everything a fallback chain reaches past stays open.
 */

import { z } from '../runtime/schema.mjs';

const ATTRIBUTE = z.looseObject({
  title: z.unknown().optional(),
  description: z.unknown().optional(),
});

const PRICE_LIST = z.looseObject({
  groups: z.array(z.looseObject({
    values: z.array(z.looseObject({
      title: z.unknown().optional(),
      price: z.unknown().optional(),
    })).max(200),
  })).max(20),
});

/** A photo as several sizes under opaque keys; which sizes exist is Avito's (D-023). */
const IMAGE_VARIANTS = z.record(z.string(), z.unknown());

const ITEM = z.looseObject({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  price: z.unknown().optional(),
  formattedPrice: z.unknown().optional(),
  description: z.unknown().optional(),
  descriptionHtml: z.unknown().optional(),
  hasWysiwyg: z.unknown().optional(),
  location: z.unknown().optional(),
  address: z.unknown().optional(),
  sellerAddressInfo: z.unknown().optional(),
  conditionParams: z.unknown().optional(),
  // The one rendered string the listing page has for a date, and the only place
  // it exists at all — not in the API, not in JSON-LD, not in microdata (D-039).
  sortFormatedDate: z.string().nullish(),
  searchLocation: z.array(z.looseObject({
    name: z.unknown().optional(),
    current: z.unknown().optional(),
  })).nullish(),
  imageUrls: z.array(IMAGE_VARIANTS).max(100).nullish(),
  priceList: PRICE_LIST.nullish(),
});

export const BUYER_ITEM = z.looseObject({
  item: ITEM,
  hasWysiwyg: z.unknown().optional(),
  seller: z.unknown().optional(),
  contactBarInfo: z.unknown().optional(),
  rating: z.unknown().optional(),
  galleryInfo: z.looseObject({
    media: z.array(z.looseObject({
      isVideo: z.unknown().optional(),
      urls: IMAGE_VARIANTS.nullish(),
    })).max(100).nullish(),
  }).nullish(),
  paramsDto: z.looseObject({ items: z.array(ATTRIBUTE).nullish() }).nullish(),
  paramsBlock: z.looseObject({ items: z.array(ATTRIBUTE).nullish() }).nullish(),
});
