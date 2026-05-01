import { Agent } from "agents";

// Phase 0 stub. Phase 2 will give this real state and an LLM tool-call loop.
// Each Telegram group chat is mapped to one TripAgent instance, named
// `chat-<chat_id>` so per-chat state is isolated and persistent.
export class TripAgent extends Agent<Env> {
	async onRequest(_request: Request): Promise<Response> {
		return Response.json({ status: "ok", phase: 0 });
	}
}
