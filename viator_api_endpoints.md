# Viator Partner API Reference for This Bot

Last reviewed: 2026-05-01

This file is the local source of truth for LLMs implementing Viator API calls in this repository. It is scoped to a budget trip-planning bot running on Cloudflare Workers/Agents.

Official references:

- Viator Partner API v2 technical docs: https://docs.viator.com/partner-api/technical/
- Viator Partner API docs home: https://docs.viator.com/partner-api/

## Non-Negotiable Rules

- Use Viator Partner API v2 only.
- Never expose `VIATOR_API_KEY` to Telegram users, logs, client code, or error text.
- Use `recommendedRetailPrice` for user-facing prices. Viator notes that RRP can be lower than partner total cost on low-margin products.
- Do not present a final quote from search or schedule data. Call `/availability/check` for the selected date, start time, option, currency, and traveler mix first.
- Do not use `/products/{product-code}` for catalog ingestion. Use it only when the user selects a product.
- Keep booking endpoints out of scope unless the user explicitly asks to implement booking and the partner account has booking access.
- Treat schedules as stale hints. Availability can change; real-time checks are authoritative.
- Preserve `productUrl` when linking users to Viator so attribution/campaign tracking remains intact.

## Environment

| Environment | Base URL |
| --- | --- |
| Production | `https://api.viator.com/partner` |
| Sandbox | `https://api.sandbox.viator.com/partner` |

Use an environment variable for the base URL so local and production deployments can switch without code changes.

Required request headers:

| Header | Value |
| --- | --- |
| `exp-api-key` | `VIATOR_API_KEY` secret |
| `Accept` | `application/json;version=2.0` |
| `Accept-Language` | User preference, default `en-US` |
| `Content-Type` | `application/json` for POST requests |

Operational defaults:

- Timeout: use a long API timeout, up to 120 seconds for slow supplier-backed calls.
- Retries: retry `429` and transient `5xx` with exponential backoff and jitter.
- Rate limits: Viator applies per-endpoint/per-partner limits and additional IP-based security limiting. Do not fan out blindly from one chat message.

## Endpoint Map

| Endpoint | Method | Use in this bot | Cache |
| --- | --- | --- | --- |
| `/search/freetext` | POST | Natural-language search and lightweight destination/product discovery | No, or short per query |
| `/products/search` | POST | Structured budget search after resolving destination/tags | No, or short per query |
| `/destinations` | GET | Destination name to ID lookup | Weekly plus on-demand misses |
| `/attractions/search` | POST | Landmark/POI search | Weekly for known data, no cache for ad hoc queries |
| `/products/{product-code}` | GET | Details after user selects a result | Short product cache |
| `/availability/schedules/{product-code}` | GET | Calendar hints and possible dates | Short cache; do not quote from it |
| `/availability/check` | POST | Live availability and final price | Never cache as final truth |
| `/products/tags` | GET | Map activity categories to tag IDs | Weekly plus on-demand misses |
| `/exchange-rates` | POST | Currency conversion if needed | Until response expiry, otherwise daily |
| `/reviews/product` | POST | Reviews for "is this worth it?" style questions | Weekly; requires Full Affiliate or higher |

## 1. Free-Text Search

`POST /search/freetext`

Use this for user text like "cheap food tours in Lisbon" or "things to do in Tokyo under 30 GBP" when the bot has not yet resolved destination IDs or tag IDs.

Example:

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

Notes for LLM implementers:

- `searchType` can target products, destinations, or attractions depending on the interaction.
- Tag filtering for `searchType: "PRODUCTS"` is supported in the current v2 docs.
- Use this as the fallback when structured search inputs are incomplete.

## 2. Product Search

`POST /products/search`

Use this when the bot has a `destinationId`, budget, tags, rating, duration, or sorting requirements.

Example:

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

Use for:

- "Tours in Paris under $30"
- "Best rated food activities in Rome"
- "Outdoor activities in Bali below 50 EUR"

Product cards should normalize to:

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

## 3. Destinations

`GET /destinations`

Use this to build a lookup from user-facing names to Viator destination IDs.

Implementation guidance:

- Cache destination names in SQLite or Agent state.
- Store lowercased aliases, but keep display names intact.
- If a destination is ambiguous, ask the user to choose rather than guessing.
- Refresh weekly, and refresh on demand when a product references an unknown destination ID.

## 4. Attractions

`POST /attractions/search`

Use this for landmarks or points of interest like "Eiffel Tower", "Colosseum", or "Sagrada Familia".

Example:

```json
{
  "searchQuery": "Eiffel Tower",
  "currencyCode": "USD"
}
```

Use attraction results to refine the follow-up product search. If multiple attractions match, present concise choices.

## 5. Product Details

`GET /products/{product-code}`

Call this only when the user selects a product or asks for more detail.

Important response areas:

- `title`, descriptions, itinerary, inclusions, exclusions, accessibility, cancellation policy.
- `pricingInfo.type`: `PER_PERSON` or `UNIT`.
- `pricingInfo.ageBands`: age bands such as `ADULT`, `CHILD`, `YOUTH`, `SENIOR`, `INFANT`, `TRAVELER`.
- `productOptions`: option/tour-grade values; preserve `productOptionCode` for availability checks.
- `bookingQuestions`: required only if booking is implemented later.
- `productUrl`: use this for "book on Viator" links.

Do not paste very long descriptions into Telegram. Summarize and keep key terms/cancellation details visible.

## 6. Availability Schedules

`GET /availability/schedules/{product-code}`

Use schedules to propose date/start-time choices, not to finalize price.

Important model:

- Schedules describe seasons and days of week.
- They list unavailable dates rather than enumerating all available dates.
- Product options and unit/per-person pricing may affect which dates/times are valid.

Safe interpretation flow:

1. Read seasons for the selected `productCode` and `productOptionCode`.
2. Generate candidate dates in the relevant date range.
3. Keep dates whose day of week is allowed.
4. Remove dates listed in `unavailableDates`.
5. Show a small set of candidates.
6. Confirm the selected candidate with `/availability/check`.

## 7. Real-Time Availability Check

`POST /availability/check`

Call this before giving a final price or saying a tour is available.

Example:

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

Notes:

- Include `productOptionCode` when a product has options.
- Build `paxMix` from the conversation, defaulting only after confirming assumptions with the user.
- Handle rejected/unavailable results by offering the next viable dates or start times.
- Surface extra charges when present; do not hide mandatory costs.

## 8. Product Tags

`GET /products/tags`

Use tags to map natural categories to Viator tag IDs.

Examples:

- Food and drink
- Outdoor and adventure
- Cultural tours
- Day trips
- Transfers and transportation

Implementation guidance:

- Cache tags weekly.
- Keep a small curated synonym map in code or SQLite, for example `food tour -> food and drink`.
- If the LLM suggests a tag name not in cache, search tags by normalized text before falling back to free-text search.

## 9. Exchange Rates

`POST /exchange-rates`

Use when product/search currency cannot be requested directly or when converting cached values.

Example:

```json
{
  "sourceCurrency": "USD",
  "targetCurrencies": ["EUR", "GBP", "JPY"]
}
```

Guidance:

- Prefer asking Viator search/check endpoints for the user's desired `currencyCode`/`currency` when supported.
- Cache rates until the response expiry. If no expiry is available in a wrapper type, refresh daily.
- Label converted prices clearly if they are not directly returned by Viator.

## 10. Product Reviews

`POST /reviews/product`

Use only when the partner account has Full Affiliate access or higher.

Rules:

- Basic-access Affiliate partners do not have this endpoint.
- Review text is protected content and must not be indexed by search engines.
- In this Telegram bot, review text may be displayed inside the chat interface, but do not add it to public pages or searchable indexes.
- Rate-limit review refreshes; Viator requests conservative use of this endpoint.

## Pricing Models

| Model | How to calculate |
| --- | --- |
| `PER_PERSON` | Sum each age-band price multiplied by traveler count |
| `UNIT` | Multiply unit price by required units, respecting unit type and group limits |

Unit types can include `GROUP`, `ROOM`, `PACKAGE`, `VEHICLE`, `BIKE`, `BOAT`, and `AIRCRAFT`.

For quotes, prefer the total returned from `/availability/check` over local calculations.

## Recommended Bot Flow

```text
Telegram message
  -> LLM extracts intent, destination, budget, dates, travelers, currency
  -> resolve destination/tag from cache
  -> /products/search when structured inputs are available
  -> /search/freetext when inputs are loose
  -> show 3 to 5 product cards
  -> user selects product
  -> /products/{product-code}
  -> user selects option/date/travelers
  -> /availability/schedules/{product-code} for candidate slots
  -> /availability/check for live price
  -> show final quote and Viator productUrl
```

## Access by Partner Type

| Endpoint | Basic Affiliate | Full Affiliate | Booking Affiliate | Merchant |
| --- | :---: | :---: | :---: | :---: |
| `/search/freetext` | yes | yes | yes | yes |
| `/products/search` | yes | yes | yes | yes |
| `/destinations` | yes | yes | yes | yes |
| `/attractions/search` | yes | yes | yes | yes |
| `/products/{product-code}` | yes | yes | yes | yes |
| `/products/tags` | yes | yes | yes | yes |
| `/availability/schedules/{product-code}` | yes | yes | yes | yes |
| `/availability/check` | yes | yes | yes | yes |
| `/exchange-rates` | yes | yes | yes | yes |
| `/reviews/product` | no | yes | yes | yes |
| `/bookings/cart/book` | no | no | yes | yes |
| `/bookings/book` | no | no | no | yes |

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

Use `X-Unique-ID` from Viator response headers in internal logs for support, but do not show raw upstream bodies to users.
