// Viator Partner API v2 client (Affiliate model — no /bookings/* used).
// Auth pattern based on the public Affiliate Technical Guide. The on-site
// Viator engineer should confirm the exact header name (`exp-api-key`) and
// sandbox base URL before we ship the demo.

const DEFAULT_BASE_URL = "https://api.sandbox.viator.com/partner";
const ACCEPT = "application/json;version=2.0";

export interface ViatorClientOptions {
	apiKey: string;
	baseUrl?: string;
	currency?: string;
	language?: string;
}

export interface ViatorImageVariant {
	url: string;
	height?: number;
	width?: number;
}

export interface ViatorImage {
	variants?: ViatorImageVariant[];
}

export interface ViatorProduct {
	productCode: string;
	title: string;
	description?: string;
	shortDescription?: string;
	pricing?: {
		summary?: { fromPrice?: number };
		currency?: string;
	};
	images?: ViatorImage[];
	reviews?: { combinedAverageRating?: number; totalReviews?: number };
	duration?: { description?: string; fixedDurationInMinutes?: number };
	productUrl?: string;
	webURL?: string;
	tags?: number[];
}

export interface ViatorSearchResponse {
	products: ViatorProduct[];
	totalCount?: number;
}

export interface ViatorDestinationHit {
	destinationId: number;
	name: string;
	type?: string;
	parentDestinationId?: number;
}

export class ViatorClient {
	private apiKey: string;
	private baseUrl: string;
	private currency: string;
	private language: string;

	constructor(opts: ViatorClientOptions) {
		this.apiKey = opts.apiKey;
		this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
		this.currency = opts.currency ?? "USD";
		this.language = opts.language ?? "en";
	}

	private headers(extra: Record<string, string> = {}): HeadersInit {
		return {
			"exp-api-key": this.apiKey,
			Accept: ACCEPT,
			"Accept-Language": this.language,
			"Content-Type": "application/json",
			...extra,
		};
	}

	async searchProducts(params: {
		destinationId: number;
		tags?: number[];
		startDate?: string; // YYYY-MM-DD
		endDate?: string; // YYYY-MM-DD
		count?: number;
		sortOrder?: "DEFAULT" | "PRICE" | "RATING" | "RELEVANCE";
	}): Promise<ViatorSearchResponse> {
		const body: Record<string, unknown> = {
			filtering: {
				destination: String(params.destinationId),
				...(params.tags?.length ? { tags: params.tags } : {}),
				...(params.startDate ? { startDate: params.startDate } : {}),
				...(params.endDate ? { endDate: params.endDate } : {}),
			},
			pagination: { start: 1, count: params.count ?? 5 },
			currency: this.currency,
		};
		// `sort: DEFAULT` rejects an `order`; only ranked sorts (PRICE, RATING)
		// take a direction. Omit the whole sorting block to let Viator apply
		// its default ordering.
		if (params.sortOrder && params.sortOrder !== "DEFAULT") {
			body.sorting = { sort: params.sortOrder, order: "DESCENDING" };
		}

		const r = await fetch(`${this.baseUrl}/products/search`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			const text = await r.text();
			throw new ViatorError("products/search", r.status, text);
		}
		return (await r.json()) as ViatorSearchResponse;
	}

	async getProduct(productCode: string): Promise<ViatorProduct> {
		const r = await fetch(`${this.baseUrl}/products/${encodeURIComponent(productCode)}`, {
			headers: this.headers(),
		});
		if (!r.ok) {
			throw new ViatorError(`products/${productCode}`, r.status, await r.text());
		}
		return (await r.json()) as ViatorProduct;
	}

	// Resolves a free-text destination ("Lisbon") into a numeric Viator
	// destinationId. Returns the top hit, or null if none.
	async resolveDestination(text: string): Promise<ViatorDestinationHit | null> {
		const body = {
			searchTerm: text,
			searchTypes: [{ searchType: "DESTINATIONS", pagination: { start: 1, count: 5 } }],
			currency: this.currency,
		};
		const r = await fetch(`${this.baseUrl}/search/freetext`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			throw new ViatorError("search/freetext", r.status, await r.text());
		}
		const json = (await r.json()) as Record<string, unknown>;
		// Log a trimmed payload so we can see the actual shape in `wrangler tail`.
		console.log("viator.freetext.response", JSON.stringify(json).slice(0, 800));

		// Viator's response shape can vary; try a few known-plausible paths.
		const destinationsField = json.destinations as unknown;
		const candidates: unknown[] = Array.isArray(destinationsField)
			? destinationsField
			: ((destinationsField as { results?: unknown[] } | undefined)?.results ?? []);
		const top = candidates[0] as Record<string, unknown> | undefined;
		if (!top) return null;

		const rawId = top.destinationId ?? top.id ?? top.ref ?? top.destinationRef;
		const numericId = typeof rawId === "number" ? rawId : Number(rawId);
		if (!Number.isFinite(numericId)) {
			console.log("viator.freetext.no-id-on-top-hit", JSON.stringify(top));
			return null;
		}
		return {
			destinationId: numericId,
			name: (top.name as string) ?? (top.destinationName as string) ?? text,
			type: top.type as string | undefined,
			parentDestinationId: top.parentDestinationId as number | undefined,
		};
	}
}

export class ViatorError extends Error {
	constructor(
		public endpoint: string,
		public status: number,
		public responseBody: string,
	) {
		super(`Viator ${endpoint} failed (${status}): ${responseBody.slice(0, 300)}`);
		this.name = "ViatorError";
	}
}
