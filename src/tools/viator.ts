// Viator Sandbox API client. Request shapes follow viator_api_endpoints.md
// (the local source of truth, last updated by PR #2).

const DEFAULT_BASE_URL = "https://api.sandbox.viator.com/partner";
const ACCEPT = "application/json;version=2.0";

export interface ViatorClientOptions {
	apiKey: string;
	baseUrl?: string;
	currencyCode?: string;
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

// Loose typing for fields whose nested shape we haven't fully pinned down
// from real responses; helpers in format.ts narrow these as needed.
export interface ViatorProduct {
	productCode: string;
	title: string;
	description?: string;
	shortDescription?: string;
	productUrl?: string;
	images?: ViatorImage[];
	duration?: { description?: string; fixedDurationInMinutes?: number };
	rating?: number;
	reviewCount?: number;
	destinationName?: string;
	recommendedRetailPrice?: unknown;
	pricing?: unknown;
	reviews?: { combinedAverageRating?: number; totalReviews?: number };
	tags?: number[];
}

export interface ViatorSearchResponse {
	products?: ViatorProduct[];
	totalCount?: number;
}

export interface ViatorDestinationHit {
	destinationId: number;
	name: string;
}

export class ViatorClient {
	private apiKey: string;
	private baseUrl: string;
	private currencyCode: string;
	private language: string;

	constructor(opts: ViatorClientOptions) {
		this.apiKey = opts.apiKey;
		this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
		this.currencyCode = opts.currencyCode ?? "USD";
		this.language = opts.language ?? "en-US";
	}

	private headers(extra: Record<string, string> = {}): HeadersInit {
		return {
			"exp-api-key": this.apiKey,
			Accept: ACCEPT,
			"Accept-Language": this.language,
			"Accept-Encoding": "gzip",
			"Content-Type": "application/json",
			...extra,
		};
	}

	// POST /products/search — structured search after we have a destinationId.
	async searchProducts(params: {
		destinationId: number;
		tags?: number[];
		priceMin?: number;
		priceMax?: number;
		minRating?: number;
		durationMinMinutes?: number;
		durationMaxMinutes?: number;
		count?: number;
		sortBy?: "PRICE" | "TRAVELER_RATING" | "ITINERARY_DURATION";
		order?: "ASCENDING" | "DESCENDING";
	}): Promise<ViatorSearchResponse> {
		const filtering: Record<string, unknown> = {
			destinationId: params.destinationId,
		};
		if (params.tags?.length) filtering.tags = params.tags;
		if (params.priceMin != null || params.priceMax != null) {
			filtering.priceRange = {
				...(params.priceMin != null ? { min: params.priceMin } : {}),
				...(params.priceMax != null ? { max: params.priceMax } : {}),
			};
		}
		if (params.minRating) filtering.rating = { minRating: params.minRating };
		if (params.durationMinMinutes != null || params.durationMaxMinutes != null) {
			filtering.durationRange = {
				...(params.durationMinMinutes != null ? { min: params.durationMinMinutes } : {}),
				...(params.durationMaxMinutes != null ? { max: params.durationMaxMinutes } : {}),
			};
		}

		const body: Record<string, unknown> = {
			filtering,
			currency: this.currencyCode,
			pagination: { offset: 0, limit: params.count ?? 5 },
		};
		if (params.sortBy) {
			body.sorting = { sort: params.sortBy, order: params.order ?? "DESCENDING" };
		}

		const r = await fetch(`${this.baseUrl}/products/search`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			const errBody = await r.text();
			console.log("viator.error", { endpoint: "products/search", status: r.status, body: errBody.slice(0, 600) });
			throw new ViatorError("products/search", r.status, errBody);
		}
		const json = (await r.json()) as ViatorSearchResponse;
		console.log("viator.products-search.count", json.products?.length ?? 0);
		return json;
	}

	// POST /search/freetext (DESTINATIONS) — resolve free-text destination
	// names to numeric IDs. Returns the top hit, or null if none.
	async resolveDestination(text: string): Promise<ViatorDestinationHit | null> {
		const body = {
			searchTerm: text,
			searchType: "DESTINATIONS",
			currency: this.currencyCode,
			pagination: { offset: 0, limit: 5 },
		};
		const r = await fetch(`${this.baseUrl}/search/freetext`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			const errBody = await r.text();
			console.log("viator.error", { endpoint: "search/freetext", op: "DESTINATIONS", status: r.status, body: errBody.slice(0, 600) });
			throw new ViatorError("search/freetext", r.status, errBody);
		}
		const json = (await r.json()) as Record<string, unknown>;
		console.log("viator.freetext.destinations", JSON.stringify(json).slice(0, 600));

		// Try the documented shape and a couple of plausible variants.
		const destinationsField = json.destinations as unknown;
		const candidates: unknown[] = Array.isArray(destinationsField)
			? destinationsField
			: ((destinationsField as { results?: unknown[] } | undefined)?.results ?? []);
		const top = candidates[0] as Record<string, unknown> | undefined;
		if (!top) return null;

		const rawId = top.destinationId ?? top.id ?? top.ref;
		const numericId = typeof rawId === "number" ? rawId : Number(rawId);
		if (!Number.isFinite(numericId)) {
			console.log("viator.freetext.no-id-on-top-hit", JSON.stringify(top));
			return null;
		}
		return {
			destinationId: numericId,
			name: (top.name as string) ?? (top.destinationName as string) ?? text,
		};
	}

	// POST /search/freetext (PRODUCTS) — natural-language product search when
	// destination/tag IDs aren't pre-resolved.
	async freetextProducts(searchTerm: string, opts?: { tags?: number[]; limit?: number }): Promise<ViatorSearchResponse> {
		const body: Record<string, unknown> = {
			searchTerm,
			searchType: "PRODUCTS",
			currency: this.currencyCode,
			pagination: { offset: 0, limit: opts?.limit ?? 5 },
		};
		if (opts?.tags?.length) body.filtering = { tags: opts.tags };

		const r = await fetch(`${this.baseUrl}/search/freetext`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			const errBody = await r.text();
			console.log("viator.error", { endpoint: "search/freetext", op: "PRODUCTS", status: r.status, body: errBody.slice(0, 600) });
			throw new ViatorError("search/freetext", r.status, errBody);
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
}

export class ViatorError extends Error {
	constructor(
		public endpoint: string,
		public status: number,
		public responseBody: string,
	) {
		// Sanitised: short slice only, never raw bodies in user-facing text.
		super(`Viator ${endpoint} failed (${status}): ${responseBody.slice(0, 300)}`);
		this.name = "ViatorError";
	}
}
