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
import { AVITO_BASE_URL } from '../site/geo.mjs';
import { readJsonResponse } from '../browser/json.mjs';

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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CommandExecutionError('Avito item API response has an unexpected shape');
  }
  const buyerItem = payload.buyerItem;
  if (!buyerItem || typeof buyerItem !== 'object' || Array.isArray(buyerItem)) {
    throw new CommandExecutionError('Avito item API response has no buyerItem');
  }
  const observedItemId = String(buyerItem.item?.id ?? '');
  if (!/^\d+$/.test(observedItemId) || observedItemId !== expectedItemId) {
    // Named, not defaulted: "unknown" would hide the difference between Avito
    // answering about another listing and answering about none.
    throw new CommandExecutionError(observedItemId
      ? `Avito item API returned item ${observedItemId} instead of ${expectedItemId}`
      : `Avito item API returned no item ID where ${expectedItemId} was expected`);
  }

  const rating = buyerItem.rating;
  // `ratingKey` / `reviewsCount` rather than the column names: this is the rating
  // context of the listing, not a row, and naming it like one is how a carrier gets
  // mistaken for output.
  if (rating == null) return { ratingKey: null, reviewsCount: null };
  if (typeof rating !== 'object' || Array.isArray(rating)) {
    throw new CommandExecutionError('Avito item API returned a malformed seller rating');
  }

  const ratingUserKey = cleanText(rating.userKey);
  if (ratingUserKey && !/^[A-Za-z0-9]{32,64}$/.test(ratingUserKey)) {
    throw new CommandExecutionError('Avito item API returned a malformed seller rating key');
  }

  // Same source and semantics as sellerReviewsCount in item and the search-compatible
  // rows: the visible summary counts scored reviews only, unlike activeReviewsCount.
  const summary = cleanText(rating.summary);
  let sellerReviewsCount = null;
  if (summary) {
    if (/^нет отзывов$/i.test(summary)) {
      sellerReviewsCount = 0;
    } else {
      const digits = summary.replace(/[^\d]/g, '');
      const count = digits ? Number(digits) : NaN;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new CommandExecutionError(`Avito item API returned an unreadable review summary "${summary}"`);
      }
      sellerReviewsCount = count;
    }
  }

  return { ratingKey: ratingUserKey || null, reviewsCount: sellerReviewsCount };
}

function decodeReviewImages(rawImages) {
  if (rawImages == null) return [];
  if (!Array.isArray(rawImages) || rawImages.length > MAX_REVIEW_IMAGES) return null;

  const images = [];
  const seen = new Set();
  for (const rawImage of rawImages) {
    if (!rawImage || typeof rawImage !== 'object' || Array.isArray(rawImage)) return null;
    // Avito owns the set of size keys, so the largest offered variant wins instead of a
    // named pair: a renamed key costs nothing, and an entry carrying no size at all still
    // fails closed rather than dropping a photo silently (F-047).
    let source = null;
    let sourceArea = -1;
    for (const [key, value] of Object.entries(rawImage)) {
      const url = cleanText(value);
      const size = /^(\d+)x(\d+)$/.exec(key);
      if (!url || !size) continue;
      const area = Number(size[1]) * Number(size[2]);
      if (area > sourceArea) {
        sourceArea = area;
        source = url;
      }
    }
    if (!source) return null;

    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith(IMAGE_HOST_SUFFIX)) return null;

    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    images.push(url);
  }
  return images;
}

/**
 * Decode one visible review. A review without a score is a real class, not missing data:
 * Avito prints those under the "Отзывы без оценки" divider and keeps them out of the
 * rating, so the score stays null instead of collapsing to 0 (F-046).
 */
function decodeReviewRow(entry, sellerReviewsCount) {
  const value = entry?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const reviewId = Number(value.id);
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) return null;

  let score = null;
  if (value.score != null) {
    const rawScore = Number(value.score);
    if (!Number.isSafeInteger(rawScore) || rawScore < 1 || rawScore > 5) return null;
    score = rawScore;
  }

  const authorName = cleanText(value.title);
  if (!authorName) return null;

  const textSections = value.textSections == null ? [] : value.textSections;
  if (!Array.isArray(textSections)) return null;
  const textParts = [];
  for (const section of textSections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
    const part = cleanText(section.text);
    if (part) textParts.push(part);
  }

  const answer = value.answer;
  if (answer != null && (typeof answer !== 'object' || Array.isArray(answer))) return null;

  const images = decodeReviewImages(value.images);
  if (images === null) return null;

  return {
    reviewId,
    score,
    stage: cleanText(value.stageTitle) || null,
    rated: cleanText(value.rated) || null,
    authorName,
    authorRole: cleanText(value.titleCaption) || null,
    itemTitle: cleanText(value.itemTitle) || null,
    text: textParts.join('\n') || null,
    answerText: answer ? (cleanText(answer.text) || null) : null,
    answered: answer ? (cleanText(answer.answered) || null) : null,
    images,
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
  columns: [
    'reviewId',
    'score',
    'stage',
    'rated',
    'authorName',
    'authorRole',
    'itemTitle',
    'text',
    'answerText',
    'answered',
    'images',
    'sellerReviewsCount',
  ],
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
      const row = decodeReviewRow(entry, reviewsCount);
      if (!row) throw new CommandExecutionError('Avito reviews response has a malformed review entry');
      rows.push(row);
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
