// Viator Partner API v2 client (Affiliate model — no /bookings/* used).
// Auth pattern based on the public Affiliate Technical Guide. The on-site
// Viator engineer should confirm the exact header name (`exp-api-key`) and
// sandbox base URL before we ship the demo.

const DEFAULT_BASE_URL = "https://api.viator.com/partner";
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
			sorting: { sort: params.sortOrder ?? "DEFAULT", order: "ASCENDING" },
			pagination: { start: 1, count: params.count ?? 5 },
			currency: this.currency,
		};

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
		const json = (await r.json()) as { destinations?: { results?: ViatorDestinationHit[] } };
		return json.destinations?.results?.[0] ?? null;
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
