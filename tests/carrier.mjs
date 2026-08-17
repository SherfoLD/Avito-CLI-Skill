// Synthetic Avito carriers shared by the browser-side suites.
//
// The shapes mirror what was confirmed live: the visible card text lives in
// `iva.DescriptionStep` (the flat `description` is empty in the SSR catalog and populated in
// the items API response), the shown price in `iva.PriceStep` while `item.priceDetailed`
// keeps the base price, and the visible location line is built from `geo.geoReferences`.
// Keep them in sync with the findings in the project memory when Avito drifts.
import { parseHTML } from 'linkedom';

export const ORIGIN = 'https://www.avito.ru';

export const { DOMParser } = parseHTML('<html></html>');

export function bootstrapHtml(loaderData) {
  return `<html><head><title>Авито</title></head><body><div>catalog</div>
    <script data-mfe-state="true" type="mime/invalid">${JSON.stringify(loaderData)}</script>
  </body></html>`;
}

// One card photo as Avito serves it: the same picture under several size keys, each with
// its own opaque URL, listed in an order Avito is free to change.
export function cardPhoto(name, host = '50') {
  return {
    '318x318': `https://${host}.img.avito.st/image/1/${name}-318.jpg`,
    '636x636': `https://${host}.img.avito.st/image/1/${name}-636.jpg`,
    '208x208': `https://${host}.img.avito.st/image/1/${name}-208.jpg`,
    '416x416': `https://${host}.img.avito.st/image/1/${name}-416.jpg`,
  };
}

export function item({
  id = '7881841669',
  title = 'DDR5 32gb Kingston Fury',
  basePrice = 43800,
  visiblePrice = 43691,
  geoReference = { content: 'Китай-город', afterWithIcon: { text: 'до 5 мин.' } },
  locationName = 'Москва',
  description = 'Авитодоставка открыта — можете сразу оформить комплект.',
  // Every catalog card carries the stamp Avito sorts by and prints on the listing page:
  // 1786662941000 is 14 August 2026, 02:15:41 Moscow time (F-059).
  sortTimeStamp = 1786662941000,
  flatDescription = '',
  // An anonymous session gets no seller-info step at all on a private seller's card: the
  // whole UserInfoStep array comes back empty while the flat rating stays (F-049).
  sellerInfo = true,
  rating = { score: 5, summary: '2 015 отзывов', showChevronEnd: false },
  images = [cardPhoto('one'), cardPhoto('two')],
  // Avito ships a flat boolean on every catalog card; `null` here means the key is absent,
  // which is the drift case the reservation filter must refuse instead of guessing.
  isReserved = false,
  // `number` prints the price, `floor` prints «от <price>», and the two phrase
  // forms print no number at all: both set the flat value to 0 and `hasValue` to
  // false, and only the step tells them apart (F-076).
  priceForm = 'number',
  // The unit, as Avito sends it beside the number rather than inside it (F-077).
  priceUnit = '',
  // A services card prices by a table, and then the scalar beside it is a floor
  // (F-079). `values` is what Avito draws, `valuesAll` the whole list.
  priceList = null,
} = {}) {
  // Avito prints the floor of a range as part of the price string and marks it
  // nowhere else, which is why the decoder tests the shape of the string (F-078).
  const printed = priceForm === 'floor' ? `от ${visiblePrice}` : String(visiblePrice);
  const phrase = priceForm === 'negotiable' ? 'Цена договорная' : 'Бесплатно';
  const hasNumber = priceForm === 'number' || priceForm === 'floor';
  const flatPrice = hasNumber
    ? {
      value: basePrice,
      string: priceForm === 'floor' ? `от ${basePrice}` : String(basePrice),
      fullString: `${basePrice} ₽`,
      hasValue: true,
      postfix: priceUnit,
    }
    : { value: 0, string: phrase, fullString: phrase, hasValue: false, postfix: priceUnit };
  const stepPrice = hasNumber
    ? { value: visiblePrice, string: printed, discountType: 'item_bonus', valueOld: `${basePrice} ₽`, postfix: priceUnit }
    : { value: priceForm === 'negotiable' ? null : 0, string: phrase, postfix: priceUnit };
  return {
    type: 'item',
    id,
    title,
    ...(isReserved == null ? {} : { isReserved }),
    urlPath: `/moskva/tovary_dlya_kompyutera/ddr5_${id}`,
    ...(sortTimeStamp == null ? {} : { sortTimeStamp }),
    description: flatDescription,
    priceDetailed: flatPrice,
    ...(priceList == null ? {} : { priceList }),
    location: locationName ? { id: 637640, name: locationName } : null,
    rating,
    addressDetailed: { locationName: locationName || '' },
    geo: { formattedAddress: '', geoReferences: geoReference ? [geoReference] : [] },
    // A real card ships one photo in six sizes, each with its own opaque URL and in no
    // fixed key order, so the carrier mirrors that instead of a single named size.
    images,
    iva: {
      PriceStep: visiblePrice == null && hasNumber ? [] : [{
        componentData: { component: 'price' },
        payload: { priceDetailed: stepPrice },
      }],
      DescriptionStep: description == null ? [] : [{ componentData: { component: 'description' }, payload: { description } }],
      GeoStep: [{ componentData: { component: 'geo' }, payload: { geoForItems: { geoReferences: geoReference ? [geoReference] : [], addressLocality: locationName || '' } } }],
      UserInfoStep: sellerInfo ? [{
        componentData: { component: 'seller-info' },
        payload: {
          profile: { link: '/brands/i161396332?src=search_seller_info&iid=7881841669', title: 'AMD INTEL' },
          rating: { score: 5, summary: '2 015 отзывов' },
        },
      }] : [],
    },
  };
}

export const FILTERS = {
  Sections: [{
    Filters: [
      { id: 'price', type: 'numericRange' },
      { id: 'user', type: 'radioGroup', values: [{ value: '0', name: 'Все' }, { value: '1', name: 'Частные' }, { value: '2', name: 'Компании' }] },
      { id: 'd', type: 'checkboxGroup', values: [{ value: '1', name: 'С Авито Доставкой' }] },
      { id: 'localPriority', type: 'boolean' },
      { id: 'sort', type: 'select', values: [{ value: '101', name: 'По умолчанию' }, { value: '104', name: 'По дате' }] },
    ],
  }],
};

export const searchCore = (overrides = {}) => ({
  page: 1,
  query: 'ddr5 32gb',
  locationId: 637640,
  locationName: 'Москва',
  categoryId: 101,
  rootCategoryId: 1,
  verticalCategoryId: 2,
  params: {},
  sort: null,
  ...overrides,
});

/** Stubbed browser `fetch`: routes are matched by URL prefix and every call is recorded. */
export function makeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const route = routes.find((r) => url.startsWith(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return {
      status: route.status ?? 200,
      ok: (route.status ?? 200) < 400,
      url: route.responseUrl ?? url,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? (route.contentType ?? 'text/html; charset=utf-8') : null) },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
}

/**
 * Run a browser-side function with the globals it expects, injected as an
 * explicit `env`. That injection is what lets the same function run here at all:
 * reading `fetch` and `location` off `globalThis` would make this suite either
 * impossible or dependent on a real network.
 */
export function evaluateRunner(browserFunction) {
  return async (args, fetchImpl, href = `${ORIGIN}/`) => browserFunction(
    args,
    { DOMParser, fetch: fetchImpl, location: { origin: ORIGIN, href } },
  );
}
