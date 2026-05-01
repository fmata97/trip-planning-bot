import { tool } from "ai";
import { z } from "zod";
import { ViatorClient, ViatorError, type ViatorProduct } from "./viator";
import type { TripAgent, TripState, CandidateProduct } from "../agent";

// Tools surfaced to the Workers AI Llama for tool-calling. Keeping the
// surface small and the parameters tight helps Llama choose the right tool
// reliably (it's weaker than GPT-5 on multi-tool reasoning).
export function buildTools(env: Env, agent: TripAgent) {
	const viator = new ViatorClient({ apiKey: env.VIATOR_API_KEY });

	function summariseProduct(p: ViatorProduct) {
		const rrp = p.recommendedRetailPrice as
			| { fromPrice?: number; amount?: number; currency?: string }
			| undefined;
		const pricing = p.pricing as { summary?: { fromPrice?: number }; currency?: string } | undefined;
		const priceFrom = rrp?.fromPrice ?? rrp?.amount ?? pricing?.summary?.fromPrice;
		const currency = rrp?.currency ?? pricing?.currency ?? "USD";
		return {
			productCode: p.productCode,
			title: p.title,
			shortDescription: p.shortDescription?.slice(0, 200),
			duration: p.duration?.description,
			priceFrom,
			currency,
			rating: p.rating ?? p.reviews?.combinedAverageRating,
			reviewCount: p.reviewCount ?? p.reviews?.totalReviews,
			productUrl: p.productUrl,
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
						productUrl: s.productUrl,
						priceFrom: s.priceFrom,
						currency: s.currency,
						rating: s.rating,
					}));
					const nextState: TripState = {
						...agent.state,
						trip: { ...agent.state.trip, destination: dest.name, destinationId: dest.destinationId },
						candidates,
					};
					agent.setState(nextState);
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
