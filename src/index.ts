import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";

export { TripAgent } from "./agent";

// Cache bot info across requests in module scope so we skip an init() call
// on every webhook delivery (per grammY Workers guide).
let botInfo: UserFromGetMe | undefined;

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		// Health check / liveness probe (handy for verifying deploy).
		if (request.method === "GET") {
			return new Response("trip-planning-bot is up", { status: 200 });
		}

		const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
		if (!botInfo) {
			await bot.init();
			botInfo = bot.botInfo;
		}

		bot.command("ping", (ctx) => ctx.reply("pong"));
		bot.command("start", (ctx) =>
			ctx.reply(
				"👋 I help group chats plan trips with Viator activities. Try /ping to verify I'm alive. Trip planning lands in the next phase.",
			),
		);

		return webhookCallback(bot, "cloudflare-mod")(request);
	},
} satisfies ExportedHandler<Env>;
