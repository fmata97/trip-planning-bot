import { Agent } from "agents";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { SYSTEM_PROMPT } from "./prompt";
import { buildTools } from "./tools";

export interface TripDetails {
	destination?: string;
	destinationId?: number;
	startDate?: string;
	endDate?: string;
	budgetPerPerson?: number;
	travelers?: number;
}

export interface CandidateProduct {
	productCode: string;
	title: string;
	shortDescription?: string;
	productUrl?: string;
	priceFrom?: number;
	currency?: string;
	rating?: number;
	imageUrl?: string;
}

// Votes are keyed by `${productCode}:up` / `${productCode}:down`. Values are
// arrays of user IDs (stringified). Kept as a fallback for the legacy
// inline-button voting path; live voting now uses Telegram polls.
export type VoteMap = Record<string, string[]>;

// Tracks the most recent Telegram poll posted in this chat so /finalize can
// look it up via stopPoll() and tally votes against the productCode list.
export interface ActivePoll {
	chatId: number;
	messageId: number;
	pollId: string;
	productCodes: string[]; // index-aligned with the poll's options
	question: string;
}

export interface TripState {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	trip: TripDetails;
	candidates: CandidateProduct[];
	votes: VoteMap;
	activePoll?: ActivePoll;
}

export interface AgentReply {
	text: string;
	// New cards to render this turn, in arrival order. Empty when the turn
	// didn't trigger a search (e.g. user just chatted).
	cards: CandidateProduct[];
}

export interface VoteCounts {
	up: number;
	down: number;
}

const HISTORY_CAP = 30;
// Workers AI Llama 4 Scout 17B Instruct — the model used in Cloudflare's own
// AIChatAgent example, with native tool-calling support on the platform.
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// One TripAgent instance per Telegram group chat (named `chat-<chat_id>`).
// Per-chat state (history, current trip, candidate activities, votes) is
// auto-persisted by the Cloudflare Agents SDK in a SQLite-backed Durable
// Object — survives restarts and deploys.
export class TripAgent extends Agent<Env, TripState> {
	initialState: TripState = { messages: [], trip: {}, candidates: [], votes: {} };

	// Set by the searchActivities tool during the LLM tool loop. Read by
	// handleMessage at the end of the turn so the worker knows which
	// candidates to render as separate Telegram cards with vote buttons.
	// Reset at the start of every turn — instance state, not persisted.
	proposedThisTurn: CandidateProduct[] = [];

	async handleMessage(text: string, _userId: number): Promise<AgentReply> {
		this.proposedThisTurn = [];
		const userMsg: ModelMessage = { role: "user", content: text };
		const history: ModelMessage[] = [...this.state.messages, userMsg];

		try {
			const workersai = createWorkersAI({ binding: this.env.AI });
			const result = await generateText({
				model: workersai(MODEL),
				system: SYSTEM_PROMPT,
				messages: history,
				tools: buildTools(this.env, this),
				stopWhen: stepCountIs(6),
				// Workers AI defaults to ~256 max output tokens, which truncates
				// our 3-5 activity replies mid-sentence. 1024 covers a verbose
				// reply plus the appended booking-links section.
				maxOutputTokens: 1024,
				onStepFinish: ({ text, toolCalls, toolResults, finishReason }) => {
					console.log("agent.step", {
						finishReason,
						toolCalls: toolCalls?.map((c) => ({
							name: c.toolName,
							input: JSON.stringify(c.input).slice(0, 300),
						})),
						toolResults: toolResults?.map((r) => ({
							name: r.toolName,
							output: JSON.stringify(r.output ?? (r as { result?: unknown }).result).slice(0, 500),
						})),
						textPreview: text?.slice(0, 200),
					});
				},
			});

			console.log("agent.final", {
				steps: result.steps?.length,
				totalToolCalls: result.steps?.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0),
				finishReason: result.finishReason,
				textLen: result.text?.length ?? 0,
			});

			const replyText = result.text?.trim() || "Hmm — I couldn't put a reply together. Try rephrasing?";

			// Belt and suspenders: if the model talked about activities but
			// omitted the booking links, append a "Booking links" section.
			// Only use candidates proposed THIS turn — using all-time
			// state.candidates leaks links from previous searches (e.g.
			// Lisbon links appearing in a Porto reply).
			const fresh = this.proposedThisTurn;
			const hasMarkdownLink = /\]\(https?:\/\//.test(replyText);
			let finalReply = replyText;
			if (!hasMarkdownLink && fresh.length > 0) {
				const linkLines = fresh
					.filter((c) => c.productUrl)
					.slice(0, 5)
					.map((c, i) => `${i + 1}. [${c.title}](${c.productUrl})`);
				if (linkLines.length > 0) {
					finalReply = `${replyText}\n\n— Booking links —\n${linkLines.join("\n")}`;
				}
			}

			const assistantMsg = { role: "assistant" as const, content: finalReply };

			// Persist trimmed history. We only keep plain user/assistant turns;
			// tool calls are reconstructed each turn from current trip state.
			const trimmed = [
				...this.state.messages.slice(-HISTORY_CAP + 2),
				{ role: "user" as const, content: text },
				assistantMsg,
			];
			this.setState({ ...this.state, messages: trimmed });

			return { text: finalReply, cards: this.proposedThisTurn };
		} catch (err) {
			console.error("agent.handleMessage failed", err);
			return { text: "Hit an internal error reasoning about that. Try again in a moment.", cards: [] };
		}
	}

	// Toggleable vote: same user pressing the same kind clears their vote;
	// pressing the opposite kind moves their vote. Returns the new tally.
	async vote(productCode: string, userId: string, kind: "up" | "down"): Promise<VoteCounts> {
		const upKey = `${productCode}:up`;
		const downKey = `${productCode}:down`;
		const upSet = new Set(this.state.votes[upKey] ?? []);
		const downSet = new Set(this.state.votes[downKey] ?? []);

		if (kind === "up") {
			if (upSet.has(userId)) upSet.delete(userId);
			else {
				upSet.add(userId);
				downSet.delete(userId);
			}
		} else {
			if (downSet.has(userId)) downSet.delete(userId);
			else {
				downSet.add(userId);
				upSet.delete(userId);
			}
		}

		const nextVotes: VoteMap = { ...this.state.votes, [upKey]: [...upSet], [downKey]: [...downSet] };
		this.setState({ ...this.state, votes: nextVotes });
		return { up: upSet.size, down: downSet.size };
	}

	getVoteCounts(productCode: string): VoteCounts {
		return {
			up: (this.state.votes[`${productCode}:up`] ?? []).length,
			down: (this.state.votes[`${productCode}:down`] ?? []).length,
		};
	}

	// Called by the worker after it sends a Telegram poll. Records what the
	// poll was about so /finalize can stop it and map option index → product.
	async registerPoll(poll: ActivePoll): Promise<void> {
		this.setState({ ...this.state, activePoll: poll });
	}

	async getActivePoll(): Promise<ActivePoll | undefined> {
		return this.state.activePoll;
	}

	async getCandidates(): Promise<CandidateProduct[]> {
		return this.state.candidates;
	}

	// Used by /finalize after stopPoll: takes a vote count per option (in the
	// same order as the poll's productCodes) and returns the rendered summary.
	async finalizeFromPoll(voteCountsByOption: number[]): Promise<{ text: string }> {
		const poll = this.state.activePoll;
		if (!poll) return { text: "No poll to finalize. Run /plan first." };
		const candMap = new Map(this.state.candidates.map((c) => [c.productCode, c]));

		const tallied = poll.productCodes
			.map((code, i) => ({ code, votes: voteCountsByOption[i] ?? 0 }))
			.filter((t) => t.votes > 0)
			.sort((a, b) => b.votes - a.votes)
			.slice(0, 5)
			.map((t) => ({ ...candMap.get(t.code), votes: t.votes }))
			.filter((t) => t.productCode);

		if (tallied.length === 0) {
			return { text: "Nobody voted yet — open the poll above and tap your picks, then /finalize again." };
		}

		const lines = tallied.map((t, i) => {
			const meta: string[] = [];
			if (typeof t.priceFrom === "number") meta.push(`from ${t.currency ?? "USD"} ${t.priceFrom.toFixed(0)}`);
			meta.push(`${t.votes} vote${t.votes === 1 ? "" : "s"}`);
			const link = t.productUrl ? ` — [Book on Viator](${t.productUrl})` : "";
			return `${i + 1}. **${t.title}** — ${meta.join(", ")}${link}`;
		});

		const totalLow = tallied.reduce((sum, t) => sum + (t.priceFrom ?? 0), 0);
		const currency = tallied[0]?.currency ?? "USD";
		const trip = this.state.trip;
		const travelers = trip.travelers ?? 1;
		const totalGroup = totalLow * travelers;

		const header = trip.destination ? `**Top picks for ${trip.destination}**` : "**Top picks**";
		const footer = `\nPer-person from ~${currency} ${totalLow.toFixed(0)}${travelers > 1 ? ` · group of ${travelers} from ~${currency} ${totalGroup.toFixed(0)}` : ""}`;
		return { text: `${header}\n\n${lines.join("\n")}\n${footer}` };
	}

	// Produces the /finalize summary: top-voted candidates with totals.
	async finalize(): Promise<{ text: string }> {
		const candidates = this.state.candidates;
		if (candidates.length === 0) {
			return { text: "No candidates yet — search for activities first with /plan." };
		}

		const tallied = candidates.map((c) => {
			const counts = this.getVoteCounts(c.productCode);
			return { ...c, ...counts, score: counts.up - counts.down };
		});

		const top = tallied
			.filter((t) => t.score > 0)
			.sort((a, b) => b.score - a.score || (b.rating ?? 0) - (a.rating ?? 0))
			.slice(0, 5);

		if (top.length === 0) {
			return {
				text: "Nobody has voted 👍 on any activities yet. Vote on some cards above and run /finalize again.",
			};
		}

		const lines = top.map((t, i) => {
			const meta: string[] = [];
			if (typeof t.priceFrom === "number") meta.push(`from ${t.currency ?? "USD"} ${t.priceFrom.toFixed(0)}`);
			meta.push(`${t.up}👍 ${t.down}👎`);
			const link = t.productUrl ? ` — [Book on Viator](${t.productUrl})` : "";
			return `${i + 1}. **${t.title}** — ${meta.join(", ")}${link}`;
		});

		const totalLow = top.reduce((sum, t) => sum + (t.priceFrom ?? 0), 0);
		const currency = top[0]?.currency ?? "USD";
		const trip = this.state.trip;
		const travelers = trip.travelers ?? 1;
		const totalGroup = totalLow * travelers;

		const header = trip.destination ? `**Top picks for ${trip.destination}**` : "**Top picks**";
		const footer = `\nPer-person from ~${currency} ${totalLow.toFixed(0)}${travelers > 1 ? ` · group of ${travelers} from ~${currency} ${totalGroup.toFixed(0)}` : ""}`;
		return { text: `${header}\n\n${lines.join("\n")}\n${footer}` };
	}
}
