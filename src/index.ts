import { Bot, webhookCallback } from "grammy";
import type { Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { getAgentByName } from "agents";
import { TripAgent } from "./agent";

export { TripAgent };

// Cache bot info across requests (per grammY Workers guide).
let botInfo: UserFromGetMe | undefined;

async function routeToAgent(env: Env, chatId: number, text: string, userId: number): Promise<string> {
	const agent = await getAgentByName<Env, TripAgent>(env.TRIP_AGENT, `chat-${chatId}`);
	return await agent.handleMessage(text, userId);
}

async function replyWithAgent(ctx: Context, env: Env, text: string): Promise<void> {
	const chatId = ctx.chat?.id;
	const userId = ctx.from?.id;
	if (!chatId || !userId) return;
	await ctx.replyWithChatAction("typing").catch(() => {}); // best-effort
	const reply = await routeToAgent(env, chatId, text, userId);
	await ctx.reply(reply, {
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true },
	});
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		if (request.method === "GET") {
			return new Response("trip-planning-bot is up", { status: 200 });
		}

		const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
		if (!botInfo) {
			await bot.init();
			botInfo = bot.botInfo;
		}

		bot.command("ping", (ctx) => {
			console.log("cmd=/ping", { chatId: ctx.chat?.id, userId: ctx.from?.id });
			return ctx.reply("pong");
		});

		bot.command("start", (ctx) => {
			console.log("cmd=/start", { chatId: ctx.chat?.id, userId: ctx.from?.id });
			return ctx.reply(
				"👋 I help group chats plan trips with Viator activities.\n\n" +
					"Just talk to me: <i>plan us 3 days in Rome late May, food and history, budget 150 each</i>\n" +
					"Or use <code>/plan Lisbon</code>.",
				{ parse_mode: "HTML" },
			);
		});

		bot.command("plan", async (ctx) => {
			const args = (ctx.match ?? "").trim();
			console.log("cmd=/plan", { chatId: ctx.chat?.id, userId: ctx.from?.id, args });
			if (!args) {
				return ctx.reply(
					"Tell me where: <code>/plan Lisbon</code> or just describe the trip.",
					{ parse_mode: "HTML" },
				);
			}
			await replyWithAgent(ctx, env, `Plan a trip: ${args}`);
		});

		// Catch-all: any other text reaching us goes to the agent.
		// In groups with privacy mode ON this only fires on @mentions / replies
		// to the bot, which is exactly the surface we want.
		bot.on("message:text", async (ctx) => {
			const text = ctx.message.text;
			if (text.startsWith("/")) return; // commands handled above
			console.log("msg.text", { chatId: ctx.chat?.id, userId: ctx.from?.id, len: text.length });
			await replyWithAgent(ctx, env, text);
		});

		return webhookCallback(bot, "cloudflare-mod")(request);
	},
} satisfies ExportedHandler<Env>;
