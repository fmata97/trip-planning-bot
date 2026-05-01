import { tool } from "ai";
import { z } from "zod";
import { ViatorClient, ViatorError, type ViatorImage } from "./viator";
import { decorateAffiliateUrl } from "../affiliate";
import type { TripAgent, TripState, CandidateProduct } from "../agent";

// Pick a Telegram-friendly image variant (400-800px wide). Telegram's
// sendPhoto wants width >= 320 to look good in chat.
function pickImageUrl(images?: ViatorImage[]): string | undefined {
	const variants = images?.[0]?.variants ?? [];
	const sorted = [...variants].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
	const ideal = sorted.find((v) => (v.width ?? 0) >= 400 && (v.width ?? 0) <= 800);
	return (ideal ?? sorted[sorted.length - 1] ?? variants[0])?.url;
}

// Tools surfaced to the Workers AI Llama for tool-calling. Keeping the
// surface small and the parameters tight helps Llama choose the right tool
// reliably (it's weaker than GPT-5 on multi-tool reasoning).
export function buildTools(env: Env, agent: TripAgent) {
	const viator = new ViatorClient({ apiKey: env.VIATOR_API_KEY });

	function summariseProduct(p: {
		productCode: string;
		title: string;
		shortDescription?: string;
		description?: string;
		productUrl?: string;
		duration?: { description?: string };
		pricing?: { summary?: { fromPrice?: number }; currency?: string };
		recommendedRetailPrice?: unknown;
		reviews?: { combinedAverageRating?: number; totalReviews?: number };
		rating?: number;
		reviewCount?: number;
		images?: ViatorImage[];
	}) {
		const rrp = p.recommendedRetailPrice as { fromPrice?: number; amount?: number; currency?: string } | undefined;
		const priceFrom = rrp?.fromPrice ?? rrp?.amount ?? p.pricing?.summary?.fromPrice;
		const currency = rrp?.currency ?? p.pricing?.currency ?? "USD";
		const rating = p.rating ?? p.reviews?.combinedAverageRating;
		const reviewCount = p.reviewCount ?? p.reviews?.totalReviews;
		// Affiliate-decorated booking URL — falls back to raw productUrl if
		// VIATOR_AFFILIATE_ID is unset.
		const bookUrl = decorateAffiliateUrl(p.productUrl, env.VIATOR_AFFILIATE_ID);

		// Pre-formatted line the LLM is instructed to copy verbatim. Doing
		// the formatting here removes the chance of the model dropping the
		// link when summarising 5 activities at once.
		const priceStr = typeof priceFrom === "number" ? `from ${currency} ${priceFrom.toFixed(0)}` : "";
		const ratingStr = typeof rating === "number" ? `${rating.toFixed(1)}★` : "";
		const meta = [priceStr, ratingStr].filter(Boolean).join(", ");
		const link = bookUrl ? `[Book on Viator](${bookUrl})` : "";
		const markdownLine = [
			`**${p.title}**`,
			meta && `— ${meta}`,
			link && `— ${link}`,
		].filter(Boolean).join(" ");

		return {
			productCode: p.productCode,
			title: p.title,
			shortDescription: p.shortDescription?.slice(0, 200),
			duration: p.duration?.description,
			priceFrom,
			currency,
			rating,
			reviewCount,
			bookUrl,
			markdownLine,
			imageUrl: pickImageUrl(p.images),
		};
	}

	return {
		searchActivities: tool({
			description: "Search Viator for tours, activities and experiences in a destination. Returns a shortlist with title, price, rating, and a productCode you can use with getActivityDetails.",
			inputSchema: z.object({
				destination: z.string().describe("City or region name like 'Lisbon' or 'Rome'."),
				count: z.number().int().min(1).max(10).optional().describe("How many results to return. Default 5."),
			}),
			execute: async ({ destination, count }) => {
				try {
					const dest = await viator.resolveDestination(destination);
					if (!dest) {
						return { products: [], error: `No Viator destination matched "${destination}".` };
					}
					const search = await viator.searchProducts({
						destinationId: dest.destinationId,
						count: count ?? 5,
					});
					const summarised = (search.products ?? []).map(summariseProduct);
					const candidates: CandidateProduct[] = summarised.map((s) => ({
						productCode: s.productCode,
						title: s.title,
						shortDescription: s.shortDescription,
						productUrl: s.bookUrl,
						priceFrom: s.priceFrom,
						currency: s.currency,
						rating: s.rating,
						imageUrl: s.imageUrl,
					}));
					// Reset the shortlist when the user pivots to a different
					// destination — keeps Lisbon and Porto cards from mixing
					// in the same /finalize tally. Multi-themed searches for
					// the SAME destination keep accumulating, deduped by code.
					const prevDestinationId = agent.state.trip.destinationId;
					const destinationChanged =
						prevDestinationId !== undefined && prevDestinationId !== dest.destinationId;
					const baseCandidates = destinationChanged ? [] : agent.state.candidates;
					const baseVotes = destinationChanged ? {} : agent.state.votes;
					const seen = new Set(baseCandidates.map((c) => c.productCode));
					const fresh = candidates.filter((c) => !seen.has(c.productCode));
					const merged = [...baseCandidates, ...fresh];
					const nextState: TripState = {
						...agent.state,
						trip: { ...agent.state.trip, destination: dest.name, destinationId: dest.destinationId },
						candidates: merged,
						votes: baseVotes,
					};
					agent.setState(nextState);
					// Tell the worker which cards to render this turn.
					agent.proposedThisTurn = [...agent.proposedThisTurn, ...fresh];
					return { destination: dest.name, count: summarised.length, products: summarised };
				} catch (err) {
					if (err instanceof ViatorError) {
						return { products: [], error: `Viator ${err.endpoint} failed (${err.status})` };
					}
					console.error("tool.searchActivities unexpected", err);
					return { products: [], error: "Unexpected error reaching Viator." };
				}
			},
		}),

		getActivityDetails: tool({
			description: "Fetch the full details for ONE activity by its productCode (returned by searchActivities). Use only after the user expresses interest in a specific activity.",
			inputSchema: z.object({
				productCode: z.string().describe("Viator productCode like '5010SYDNEY'."),
			}),
			execute: async ({ productCode }) => {
				try {
					const p = await viator.getProduct(productCode);
					return summariseProduct({
						...p,
						shortDescription: p.shortDescription ?? p.description?.slice(0, 300),
					});
				} catch (err) {
					if (err instanceof ViatorError) {
						return { error: `Viator ${err.endpoint} failed (${err.status})` };
					}
					console.error("tool.getActivityDetails unexpected", err);
					return { error: "Unexpected error fetching activity details." };
				}
			},
		}),

		setTripDetails: tool({
			description: "Save or update structured trip details for the group: destination name, travel dates, per-person budget in USD, traveller count.",
			inputSchema: z.object({
				destination: z.string().optional(),
				startDate: z.string().optional().describe("YYYY-MM-DD"),
				endDate: z.string().optional().describe("YYYY-MM-DD"),
				budgetPerPerson: z.number().optional(),
				travelers: z.number().int().min(1).optional(),
			}),
			execute: async (params) => {
				const nextTrip = { ...agent.state.trip, ...params };
				agent.setState({ ...agent.state, trip: nextTrip });
				return { saved: true, trip: nextTrip };
			},
		}),
	};
}
