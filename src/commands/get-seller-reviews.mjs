/**
 * `avito get-seller-reviews` — the node half, which is all of the decoding.
 *
 * Two JSON reads: the listing API for the seller's rating key, then the feed.
 * The key is never an argument — an unknown one returns `HTTP 200` with an empty
 * feed, indistinguishable from a seller with no reviews, so a caller who could
 * pass one would get "no reviews" for a typo forever (F-046).
 *
 * Three more things Avito owns and this command therefore does not:
 *
 *   page size    fixed pages of 25, a smaller `limit` ignored — hence `--page`
 *                and no `--limit`
 *   sort         the vocabulary is per seller, so `--sort` is checked against the
 *                fresh response. A silently downgraded sort is refused: a feed
 *                sorted the other way is exactly as plausible as the right one
 *   a null score a review without one is a real class, printed under Avito's own
 *                "Отзывы без оценки" divider — it never collapses to 0
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import {
  count,
  decode,
  httpsUrl,
  optionalText,
  requiredText,
  text,
  z,
} from '../runtime/schema.mjs';
import { AVITO_BASE_URL } from '../site/geo.mjs';
import { readJsonResponse } from '../browser/prelude/json.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const IMAGE_HOST_SUFFIX = '.img.avito.st';
// Avito serves the feed in fixed pages of 25 and ignores a smaller limit (F-046), so the
// page size is a property of the server, not an argument.
const FEED_PAGE_SIZE = 25;
const MAX_FEED_ENTRIES = 200;
const MAX_REVIEW_IMAGES = 20;

/**
 * The rating context of the listing: the feed key and the visible review count.
 * `item` is optional so that "Avito answered about no listing at all" keeps its
 * own message instead of becoming a shape error.
 */
const RATING_CONTEXT = z.object({
  buyerItem: z.object({
    item: z.object({ id: z.unknown() }).nullish(),
    rating: z.object({
      userKey: optionalText(),
      summary: optionalText(),
    }).nullish(),
  }),
});

/**
 * One photo as Avito ships it: the same picture under several size keys, beside
 * companion metadata of Avito's own — `originalSize` is an object of `width` and
 * `height` (F-075). Only the size keys are read, so nothing else is constrained
 * here; what a size key is allowed to carry is checked where the size vocabulary
 * lives, in `decodeReviewImages`.
 */
const IMAGE_VARIANTS = z.record(z.string(), z.unknown());

/**
 * One visible review. A review without a score is a real class, not missing
 * data: Avito prints those under its own "Отзывы без оценки" divider and keeps
 * them out of the rating, so the score stays null instead of collapsing to 0
 * (F-046).
 */
const REVIEW = z.object({
  id: z.coerce.number().int().positive(),
  score: z.coerce.number().int().min(1).max(5).nullable().default(null),
  stageTitle: optionalText(),
  rated: optionalText(),
  title: requiredText(),
  titleCaption: optionalText(),
  itemTitle: optionalText(),
  textSections: z.array(z.object({ text: optionalText() })).default([]),
  answer: z.object({ text: optionalText(), answered: optionalText() }).nullish(),
  images: z.array(IMAGE_VARIANTS).max(MAX_REVIEW_IMAGES).nullable().default([]),
});

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, 20);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function normalizeItemUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError('itemUrl must be a non-empty Avito item URL');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArgumentError('itemUrl must be a valid absolute URL');
  }

  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new ArgumentError('itemUrl must use https://www.avito.ru');
  }

  const normalizedPath = parsed.pathname.replace(/\/$/, '');
  const match = normalizedPath.match(/_(\d+)$/);
  if (!match) {
    throw new ArgumentError('itemUrl must end with an Avito item ID, for example ..._8030214066');
  }

  return {
    normalizedUrl: `https://www.avito.ru${normalizedPath}`,
    normalizedItemId: match[1],
    itemApiUrl: `https://www.avito.ru/items/ads${normalizedPath}`,
  };
}

/**
 * Only the shape is checked here. The real vocabulary is per seller and only Avito knows
 * it, so the requested value is validated against the fresh response (F-046).
 */
function normalizeSort(value) {
  if (value == null) return null;
  const sort = cleanText(value);
  if (!sort) throw new ArgumentError('--sort must be a non-empty Avito sort value');
  if (!/^[a-z][a-z_]{2,39}$/.test(sort)) {
    throw new ArgumentError(
      '--sort must be an Avito sort value such as date_desc, date_asc, score_desc, score_asc or goods_relevant_desc',
    );
  }
  return sort;
}

// The server owns the page size, so the caller moves through the feed by page number and
// receives every review Avito put on that page.
function normalizePage(value) {
  if (value == null) return 1;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new ArgumentError('--page must be a positive safe integer');
  }
  return page;
}

function buildFeedUrl({ ratingUserKey, itemId, offset, sort }) {
  const feedUrl = new URL(`/web/7/user/${ratingUserKey}/ratings`, AVITO_BASE_URL);
  // fromItem is always sent: it is what makes the goods-relevance sort available at all,
  // and Avito silently downgrades that value to date_desc without it (F-046).
  feedUrl.searchParams.set('fromItem', itemId);
  feedUrl.searchParams.set('limit', String(FEED_PAGE_SIZE));
  feedUrl.searchParams.set('offset', String(offset));
  feedUrl.searchParams.set('photoOnly', 'false');
  if (sort) feedUrl.searchParams.set('sortRating', sort);
  return feedUrl.toString();
}

/**
 * Read the rating context of the listing: the feed key and the visible review count.
 * The key is never an argument, because an unknown key returns HTTP 200 with an empty
 * feed and would be indistinguishable from a seller without reviews (F-046).
 */
function decodeRatingContext(payload, expectedItemId) {
  const { buyerItem } = decode(RATING_CONTEXT, payload, 'Avito item API response');

  const observedItemId = String(buyerItem.item?.id ?? '');
  if (!/^\d+$/.test(observedItemId) || observedItemId !== expectedItemId) {
    // Named, not defaulted: "unknown" would hide the difference between Avito
    // answering about another listing and answering about none.
    throw new CommandExecutionError(observedItemId
      ? `Avito item API returned item ${observedItemId} instead of ${expectedItemId}`
      : `Avito item API returned no item ID where ${expectedItemId} was expected`);
  }

  // `ratingKey` / `reviewsCount` rather than the column names: this is the rating
  // context of the listing, not a row, and naming it like one is how a carrier gets
  // mistaken for output.
  const rating = buyerItem.rating;
  if (rating == null) return { ratingKey: null, reviewsCount: null };

  if (rating.userKey && !/^[A-Za-z0-9]{32,64}$/.test(rating.userKey)) {
    throw new CommandExecutionError('Avito item API returned a malformed seller rating key');
  }

  return { ratingKey: rating.userKey, reviewsCount: decodeReviewSummary(rating.summary) };
}

/**
 * Same source and semantics as `sellerReviewsCount` in `get-item` and the
 * listing rows: the visible summary counts scored reviews only, unlike
 * `activeReviewsCount`. "нет отзывов" is a real zero.
 */
function decodeReviewSummary(summary) {
  if (!summary) return null;
  if (/^нет отзывов$/i.test(summary)) return 0;
  const digits = summary.replace(/[^\d]/g, '');
  const parsed = digits ? Number(digits) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CommandExecutionError(`Avito item API returned an unreadable review summary "${summary}"`);
  }
  return parsed;
}

/**
 * Avito owns the set of size keys, so the largest offered variant wins instead
 * of a named pair: a renamed key then costs nothing, while an entry carrying no
 * size at all fails closed rather than dropping a photo silently (F-047).
 */
function decodeReviewImages(variantSets, position) {
  const images = [];
  const seen = new Set();
  for (const variants of variantSets) {
    let source = null;
    let sourceArea = -1;
    for (const [key, value] of Object.entries(variants)) {
      const size = /^(\d+)x(\d+)$/.exec(key);
      // A size key that carries anything but text is not a photo URL: `String()` of a
      // structure is `[object Object]`, which is non-empty and would pass for one.
      if (!size || typeof value !== 'string') continue;
      const url = cleanText(value);
      if (!url) continue;
      const area = Number(size[1]) * Number(size[2]);
      if (area > sourceArea) {
        sourceArea = area;
        source = url;
      }
    }
    if (!source) {
      throw new CommandExecutionError(`Avito review ${position} carries a photo with no recognizable size variant`);
    }

    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      throw new CommandExecutionError(`Avito review ${position} carries a malformed photo URL`);
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith(IMAGE_HOST_SUFFIX)) {
      throw new CommandExecutionError(`Avito review ${position} carries a photo outside Avito image hosting`);
    }

    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      images.push(parsed.href);
    }
  }
  return images;
}

function decodeReviewRow(entry, sellerReviewsCount, position) {
  const review = decode(REVIEW, entry?.value, `Avito review ${position}`);
  const textParts = review.textSections.map((section) => section.text).filter(Boolean);

  return {
    reviewId: review.id,
    score: review.score,
    stage: review.stageTitle,
    rated: review.rated,
    authorName: review.title,
    authorRole: review.titleCaption,
    itemTitle: review.itemTitle,
    text: textParts.join('\n') || null,
    answerText: review.answer?.text ?? null,
    answered: review.answer?.answered ?? null,
    images: decodeReviewImages(review.images ?? [], position),
    sellerReviewsCount,
  };
}

/** Read the sort vocabulary Avito advertises for this seller; absent on deep pages. */
function readSortSchema(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const schemaEntry = entries.find((entry) => entry?.type === 'searchParametersV2');
  if (!schemaEntry) return null;

  const blocks = schemaEntry.value?.blocks;
  if (!Array.isArray(blocks)) {
    throw new CommandExecutionError('Avito reviews response has a malformed filter schema');
  }
  const sortBlock = blocks.find((block) => block?.sort)?.sort;
  if (!sortBlock || typeof sortBlock !== 'object') return null;
  if (!Array.isArray(sortBlock.options)) {
    throw new CommandExecutionError('Avito reviews response has a malformed sort schema');
  }

  const options = [];
  for (const option of sortBlock.options) {
    const optionValue = cleanText(option?.value);
    if (!optionValue) throw new CommandExecutionError('Avito reviews response has an unnamed sort option');
    if (!options.includes(optionValue)) options.push(optionValue);
  }
  const selectedOption = cleanText(sortBlock.selectedOption) || null;
  return { options, selectedOption };
}

/**
 * Read the applied sort and offset out of the server-generated nextPage link. Avito
 * rewrites that link with what it actually applied, so it is the only postcondition
 * carrier left once the schema block stops being sent on deep pages (F-046).
 */
function readNextPage(payload, ratingUserKey) {
  const rawNextPage = cleanText(payload?.nextPage);
  if (!rawNextPage) return null;

  let parsed;
  try {
    parsed = new URL(rawNextPage, AVITO_BASE_URL);
  } catch {
    throw new CommandExecutionError('Avito reviews response has a malformed nextPage link');
  }
  if (parsed.origin !== new URL(AVITO_BASE_URL).origin
    || parsed.pathname !== `/web/7/user/${ratingUserKey}/ratings`) {
    throw new CommandExecutionError('Avito reviews nextPage link points at another feed');
  }

  const nextOffset = Number(parsed.searchParams.get('offset'));
  if (!Number.isSafeInteger(nextOffset) || nextOffset <= 0) {
    throw new CommandExecutionError('Avito reviews nextPage link has no usable offset');
  }
  return { nextOffset, appliedSort: cleanText(parsed.searchParams.get('sortRating')) || null };
}

export default defineCommand({
  name: 'get-seller-reviews',
  description: 'Get the review feed of the seller behind a listing URL',
  access: 'read',
  example: 'avito get-seller-reviews <itemUrl> --sort date_desc -f json',
  domain: 'www.avito.ru',
  args: [
    {
      name: 'itemUrl',
      type: 'string',
      required: true,
      positional: true,
      help: 'Full https://www.avito.ru item URL from any command that returns listings',
    },
    {
      name: 'sort',
      type: 'string',
      help: 'Avito sort value from this seller own vocabulary, for example date_desc or score_asc',
    },
    { name: 'page', type: 'int', default: 1, help: 'Positive feed page number; Avito fixes the page at 25 reviews' },
  ],
  // `score` is nullable because a review without one is a real class Avito
  // prints under its own divider, and `sellerReviewsCount` because the visible
  // summary is what carries it — a seller can have a feed and no summary.
  row: z.strictObject({
    reviewId: z.number().int().positive(),
    score: z.number().int().min(1).max(5).nullable(),
    stage: text().nullable(),
    rated: text().nullable(),
    authorName: text(),
    authorRole: text().nullable(),
    itemTitle: text().nullable(),
    text: text().nullable(),
    answerText: text().nullable(),
    answered: text().nullable(),
    images: z.array(httpsUrl()),
    sellerReviewsCount: count().nullable(),
  }),
  run: async (page, args) => {
    const { normalizedUrl, normalizedItemId, itemApiUrl } = normalizeItemUrl(args.itemUrl);
    const requestedSort = normalizeSort(args.sort);
    const requestedPage = normalizePage(args.page);
    const offset = (requestedPage - 1) * FEED_PAGE_SIZE;

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito API context');
    }

    // The primed origin is never text-scanned for a challenge: robots.txt lists "captcha"
    // in its own Clean-param directives (F-044). Both responses below carry the signal.
    const requestJson = async (requestUrl, action) => {
      let observed;
      try {
        observed = await page.evaluateWithArgs(readJsonResponse, { requestUrl });
      } catch (error) {
        asExecutionError(error, action);
      }
      if (!observed || typeof observed !== 'object') {
        throw new CommandExecutionError(`${action} returned an invalid result`);
      }
      if (observed.requestError) {
        asExecutionError(new Error(String(observed.requestError)), action);
      }
      if (observed.accessChallenge) {
        throw new CommandExecutionError(
          `Avito requires human verification or a rate-limit cooldown (${action} returned HTTP ${observed.responseStatus || 0})`,
        );
      }
      if (observed.responseStatus !== 200) {
        throw new CommandExecutionError(`${action} returned HTTP ${observed.responseStatus || 0}`);
      }
      if (!String(observed.responseContentType).toLowerCase().includes('application/json')
        || observed.responseParseError) {
        throw new CommandExecutionError(`${action} did not return JSON`);
      }
      return observed.payload;
    };

    const itemPayload = await requestJson(itemApiUrl, 'requesting the Avito item API');
    const { ratingKey, reviewsCount } = decodeRatingContext(itemPayload, normalizedItemId);
    if (!ratingKey) {
      throw new EmptyResultError(
        'avito get-seller-reviews',
        `The seller of item ${normalizedItemId} has no reviews on Avito`,
      );
    }

    const feedUrl = buildFeedUrl({
      ratingUserKey: ratingKey,
      itemId: normalizedItemId,
      offset,
      sort: requestedSort,
    });
    const feedPayload = await requestJson(feedUrl, 'requesting the Avito seller reviews API');
    if (!feedPayload || typeof feedPayload !== 'object' || Array.isArray(feedPayload)) {
      throw new CommandExecutionError('Avito reviews response has an unexpected shape');
    }
    const entries = feedPayload.entries;
    if (!Array.isArray(entries) || entries.length > MAX_FEED_ENTRIES) {
      throw new CommandExecutionError('Avito reviews response has a malformed entries feed');
    }

    let sortSchema = readSortSchema(feedPayload);
    const nextPage = readNextPage(feedPayload, ratingKey);
    if (nextPage && nextPage.nextOffset !== offset + FEED_PAGE_SIZE) {
      throw new CommandExecutionError(
        `Avito served page ${(nextPage.nextOffset - FEED_PAGE_SIZE) / FEED_PAGE_SIZE + 1} `
        + `instead of the requested ${requestedPage}`,
      );
    }

    if (requestedSort) {
      // A deep page that is also the last one carries neither postcondition carrier, so
      // the applied sort is confirmed by one bounded schema request at the feed start.
      if (!sortSchema && !nextPage) {
        const schemaPayload = await requestJson(
          buildFeedUrl({ ratingUserKey: ratingKey, itemId: normalizedItemId, offset: 0, sort: requestedSort }),
          'confirming the Avito reviews sort',
        );
        sortSchema = readSortSchema(schemaPayload);
      }

      if (sortSchema) {
        if (!sortSchema.options.includes(requestedSort)) {
          throw new ArgumentError(
            `--sort ${requestedSort} is unavailable for this seller; Avito offers ${sortSchema.options.join(', ')}`,
          );
        }
        if (sortSchema.selectedOption !== requestedSort) {
          throw new CommandExecutionError(sortSchema.selectedOption
            ? `Avito applied sort ${sortSchema.selectedOption} instead of the requested ${requestedSort}`
            : `Avito did not report which sort it applied instead of the requested ${requestedSort}`);
        }
      } else if (nextPage) {
        if (nextPage.appliedSort !== requestedSort) {
          throw new CommandExecutionError(nextPage.appliedSort
            ? `Avito applied sort ${nextPage.appliedSort} instead of the requested ${requestedSort}`
            : `Avito did not report which sort it applied instead of the requested ${requestedSort}`);
        }
      } else {
        throw new CommandExecutionError('Avito reviews response carried no way to confirm the applied sort');
      }
    }

    const rows = [];
    for (const entry of entries) {
      if (entry?.type !== 'rating') continue;
      rows.push(decodeReviewRow(entry, reviewsCount, rows.length + offset + 1));
    }

    if (!rows.length) {
      throw new EmptyResultError(
        'avito get-seller-reviews',
        requestedPage > 1
          ? `Avito returned no reviews on page ${requestedPage} for the seller of item ${normalizedItemId}`
          : `Avito returned no reviews for the seller of item ${normalizedItemId} (${normalizedUrl})`,
      );
    }

    return rows;
  },
});
