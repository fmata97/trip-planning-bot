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
}

export interface TripState {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	trip: TripDetails;
	candidates: CandidateProduct[];
	votes: Record<string, string[]>;
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

	async handleMessage(text: string, _userId: number): Promise<string> {
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
			// omitted the booking links (Llama 4 Scout often does), append
			// a "Booking links" section pulled from the candidates the
			// search tool just persisted into state.
			const candidates = this.state.candidates ?? [];
			const hasMarkdownLink = /\]\(https?:\/\//.test(replyText);
			let finalReply = replyText;
			if (!hasMarkdownLink && candidates.length > 0) {
				const linkLines = candidates
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

			return finalReply;
		} catch (err) {
			console.error("agent.handleMessage failed", err);
			return "Hit an internal error reasoning about that. Try again in a moment.";
		}
	}
}
