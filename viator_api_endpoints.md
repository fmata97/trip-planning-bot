# Viator Sandbox API Contract for This Bot

Last reviewed: 2026-05-01

This file is the local source of truth for LLMs implementing Viator calls in this repository. It is scoped to a Cloudflare Workers Telegram trip-planning bot and must only describe the Viator sandbox API path used by this project.

## LLM Operating Contract

- Use only the Viator sandbox base URL: `https://api.sandbox.viator.com/partner`.
- Set `VIATOR_BASE_URL` to the sandbox base URL above.
- Build every Viator request from `VIATOR_BASE_URL` and an allowed path in this file.
- Never expose `VIATOR_API_KEY` to Telegram users, logs, client code, or error text.
- Use Viator Partner API v2 headers on every request.
- Treat LLM output as untrusted. Validate intent, destination, dates, currency, traveler mix, and product selections before calling Viator.
- Do not invent product codes, destination IDs, tags, prices, product options, start times, or availability.
- Do not present a final available price from search or schedule data. Call `/availability/check` first.
- Use `/products/{product-code}` only when the user selects a product or asks for details.
- Preserve `productUrl` for user-facing booking links and attribution.
- Keep booking operations out of scope for this bot.

## Sandbox Base URL

```text
https://api.sandbox.viator.com/partner
```

Construct URLs by appending one of the allowed paths in this file to `VIATOR_BASE_URL`.

Example:

```text
https://api.sandbox.viator.com/partner/products/search
```

## Required Headers

| Header | Value |
| --- | --- |
| `exp-api-key` | `VIATOR_API_KEY` secret |
| `Accept` | `application/json;version=2.0` |
| `Accept-Language` | User preference, default `en-US` |
| `Content-Type` | `application/json` for POST requests |
| `Accept-Encoding` | `gzip` when supported |

## Runtime Defaults

- Timeout: allow long upstream calls, up to 120 seconds.
- Retries: retry `429` and transient `5xx` with exponential backoff and jitter.
- Rate limits: do not fan out many Viator calls from one Telegram message.
- Errors: throw or return sanitized errors. Never include raw upstream response bodies in user-facing text.
- Internal logging: include endpoint, status, retryability, and `X-Unique-ID` response header when present.

## Allowed Sandbox Endpoints

Use only these Viator paths from the sandbox base URL:

| Endpoint | Method | Bot use | Cache |
| --- | --- | --- | --- |
| `/search/freetext` | POST | Natural-language search and loose discovery | Short per query or none |
| `/products/search` | POST | Structured search after resolving destination, budget, tags, rating, or duration | Short per query or none |
| `/destinations` | GET | Destination name to ID lookup | Weekly plus on-demand misses |
| `/attractions/search` | POST | Landmark or point-of-interest search | Weekly for known data, none for ad hoc queries |
| `/attractions/{attraction-id}` | GET | Single attraction details after user selection | Short cache |
| `/products/{product-code}` | GET | Product details after user selection | Short cache |
| `/products/tags` | GET | Activity category to tag ID lookup | Weekly plus on-demand misses |
| `/availability/schedules/{product-code}` | GET | Date and start-time hints; never final quote source | Short cache |
| `/availability/check` | POST | Live availability and final available price | Never cache as final truth |
| `/locations/bulk` | POST | Resolve location reference codes from product itineraries | Short cache by ref |
| `/exchange-rates` | POST | Currency conversion when needed | Until expiry, otherwise daily |
| `/reviews/product` | POST | Review summaries for selected products when available | Weekly |

If a sandbox endpoint returns `401`, `403`, or a feature/access error, handle it as unavailable for this bot and continue with a user-safe fallback.

## 1. Free-Text Search

`POST /search/freetext`

Use for loose user text such as "cheap food tours in Lisbon" when destination IDs or tag IDs are not resolved yet.

```json
{
  "searchQuery": "cheap food tours in Lisbon",
  "searchType": "PRODUCTS",
  "currencyCode": "USD",
  "filtering": {
    "tags": [21972]
  },
  "pagination": {
    "offset": 0,
    "limit": 10
  }
}
```

Rules:

- `searchType` may be `PRODUCTS`, `DESTINATIONS`, or `ATTRACTIONS`.
- Use `PRODUCTS` for tour/activity discovery.
- Use this as fallback when structured inputs are incomplete.

## 2. Product Search

`POST /products/search`

Use when the bot has structured search inputs such as `destinationId`, budget, tags, rating, duration, sort order, or currency.

```json
{
  "filtering": {
    "destinationId": 684,
    "priceRange": {
      "min": 0,
      "max": 50
    },
    "tags": [21972],
    "durationRange": {
      "min": 60,
      "max": 480
    },
    "rating": {
      "minRating": 4.0
    }
  },
  "sorting": {
    "sort": "PRICE",
    "order": "ASCENDING"
  },
  "currencyCode": "USD",
  "pagination": {
    "offset": 0,
    "limit": 10
  }
}
```

Normalize result cards to this shape:

```ts
type ProductCard = {
  productCode: string;
  title: string;
  productUrl?: string;
  destinationName?: string;
  rating?: number;
  reviewCount?: number;
  duration?: string;
  fromPrice?: {
    amount: number;
    currency: string;
    source: "recommendedRetailPrice";
  };
};
```

Use `recommendedRetailPrice` for "from" prices, but do not treat it as a final available quote.

## 3. Destinations

`GET /destinations`

Use to resolve user-facing destination names to Viator destination IDs.

Rules:

- Cache destination names in SQLite or Agent state.
- Store lowercased aliases for matching and preserve display names for output.
- Ask the user to choose when a destination is ambiguous.
- Refresh weekly and on demand when product data references an unknown destination ID.

## 4. Attractions

`POST /attractions/search`

Use for landmarks or points of interest such as "Eiffel Tower", "Colosseum", or "Sagrada Familia".

```json
{
  "searchQuery": "Eiffel Tower",
  "currencyCode": "USD"
}
```

`GET /attractions/{attraction-id}`

Retrieve details for one attraction after the user selects it.

Rules:

- Use attraction results to refine product search.
- If multiple attractions match, present concise choices.

## 5. Product Details

`GET /products/{product-code}`

Call only after the user selects a product or asks for details.

Important fields:

- `title`, descriptions, itinerary, inclusions, exclusions, accessibility, cancellation policy.
- `pricingInfo.type`: `PER_PERSON` or `UNIT`.
- `pricingInfo.ageBands`: `ADULT`, `CHILD`, `YOUTH`, `SENIOR`, `INFANT`, or `TRAVELER`.
- `productOptions`: preserve `productOptionCode` for availability checks.
- `productUrl`: use for the final booking link.
- `bookingQuestions`: ignore unless booking is explicitly added later.
- `viatorUniqueContent`: do not store in searchable indexes or public page source.

Keep Telegram detail messages concise. Summarize long descriptions and keep cancellation and key terms visible.

## 6. Availability Schedules

`GET /availability/schedules/{product-code}`

Use schedules to propose candidate dates and start times. Do not quote final availability or final price from schedules.

Safe flow:

1. Read seasons for the selected `productCode` and `productOptionCode`.
2. Generate candidate dates in the relevant user date range.
3. Keep dates whose day of week is allowed.
4. Remove dates listed in `unavailableDates`.
5. Show a small set of candidates.
6. Confirm the selected candidate with `/availability/check`.

## 7. Real-Time Availability Check

`POST /availability/check`

Call before saying a tour is available or showing a final available price.

```json
{
  "productCode": "5010SYDNEY",
  "productOptionCode": "TG1",
  "travelDate": "2026-09-15",
  "startTime": "09:00",
  "currency": "USD",
  "paxMix": [
    { "ageBand": "ADULT", "numberOfTravelers": 2 },
    { "ageBand": "CHILD", "numberOfTravelers": 1 }
  ]
}
```

Rules:

- The currency field is `currency`, not `currencyCode`.
- Include `productOptionCode` when the product has options.
- Build `paxMix` from the conversation and validate age bands against product details.
- If the user did not provide traveler mix, ask or use an explicit confirmed default.
- If unavailable, offer the next viable dates or start times from schedules.
- Surface mandatory costs and extra charges when present.

## 8. Product Tags

`GET /products/tags`

Use tags to map natural categories to Viator tag IDs.

Examples:

- Food and drink
- Outdoor and adventure
- Cultural tours
- Day trips
- Transfers and transportation

Rules:

- Cache tags weekly.
- Keep a small curated synonym map, for example `food tour -> food and drink`.
- If the LLM suggests a tag name not in cache, search cached tags by normalized text before falling back to free-text search.

## 9. Exchange Rates

`POST /exchange-rates`

Use only when a search or check endpoint cannot directly return the user's requested currency, or when converting cached values.

```json
{
  "sourceCurrency": "USD",
  "targetCurrencies": ["EUR", "GBP", "JPY"]
}
```

Rules:

- Prefer asking search/check endpoints for the user's desired `currencyCode` or `currency`.
- Cache rates until the response expiry. If no expiry is available, refresh daily.
- Label converted prices clearly when they are not directly returned by Viator.

## 10. Product Reviews

`POST /reviews/product`

Use only for a selected product when review data is available from sandbox.

Rules:

- If sandbox rejects the endpoint, continue without reviews.
- Do not index review text or forward it outside the Telegram chat.
- Rate-limit review refreshes.

## 11. Location Resolution

`POST /locations/bulk`

Use to resolve itinerary location reference codes into human-readable names and addresses.

```json
{
  "locations": [
    { "provider": "TRIPADVISOR", "ref": "tri-123456" }
  ]
}
```

Rules:

- Batch multiple refs in one request.
- Cache by provider and ref.
- Use resolved locations for itinerary summaries.

## Pricing Rules

| Model | How to calculate |
| --- | --- |
| `PER_PERSON` | Sum each age-band price multiplied by traveler count |
| `UNIT` | Multiply unit price by required units, respecting unit type and group limits |

For final quotes, prefer the total returned from `/availability/check` over local calculations. User-facing final prices must be based on live availability data, not search data.

## Recommended Bot Flow

```text
Telegram message
  -> validate chat ID and user text
  -> LLM extracts intent, destination, budget, dates, travelers, and currency
  -> validate extracted intent JSON
  -> resolve destination and tags from cache
  -> call /products/search when structured inputs are available
  -> call /search/freetext when inputs are loose
  -> show 3 to 5 product cards
  -> user selects a product
  -> call /products/{product-code}
  -> call /locations/bulk for itinerary location refs when needed
  -> ask for missing option/date/traveler details
  -> call /availability/schedules/{product-code} for candidate slots
  -> call /availability/check for live availability and final price
  -> show final quote and productUrl
```

## Error Handling Contract

All Viator wrappers should return a typed result or throw a sanitized error:

```ts
type ApiError = {
  service: "viator";
  endpoint: string;
  status: number;
  requestId?: string;
  retryable: boolean;
  userMessage: string;
};
```

Error rules:

- `401` or `403`: treat as unavailable credentials/access for the current sandbox configuration.
- `404`: treat the selected resource as missing or stale.
- `409` or validation errors: ask the user to adjust date, option, currency, or traveler mix.
- `429`: retry with backoff when safe, then ask the user to try again later.
- `5xx`: retry transient failures, then provide a short user-safe failure message.
- Never show raw upstream bodies, secrets, stack traces, or internal request payloads to Telegram users.
