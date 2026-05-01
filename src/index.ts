import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { ViatorClient, ViatorError } from "./tools/viator";
import { formatActivityCard, sendActivityCard } from "./telegram/format";

export { TripAgent } from "./agent";

// Cache bot info across requests (per grammY Workers guide).
let botInfo: UserFromGetMe | undefined;

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
					"Try: <code>/plan Lisbon</code> or <code>/plan Rome food history</code>",
				{ parse_mode: "HTML" },
			);
		});

		bot.command("plan", async (ctx) => {
			const args = (ctx.match ?? "").trim();
			console.log("cmd=/plan", { chatId: ctx.chat?.id, userId: ctx.from?.id, args });
			if (!args) {
				await ctx.reply(
					"Tell me where: <code>/plan Lisbon</code> or <code>/plan Rome food history</code>",
					{ parse_mode: "HTML" },
				);
				return;
			}

			const [destination, ...tagWords] = args.split(/\s+/);
			const _tagWords = tagWords; // tag-id resolution comes in Phase 2 via the LLM

			if (!env.VIATOR_API_KEY) {
				await ctx.reply("⚠️ Viator API key not configured yet — ask the bot owner to set VIATOR_API_KEY.");
				return;
			}

			const viator = new ViatorClient({ apiKey: env.VIATOR_API_KEY });

			try {
				await ctx.replyWithChatAction("typing");
				const dest = await viator.resolveDestination(destination);
				if (!dest) {
					await ctx.reply(
						`I couldn't find "${destination}" in Viator. Try a major city (Lisbon, Rome, Paris, London…).`,
					);
					return;
				}

				const search = await viator.searchProducts({ destinationId: dest.destinationId, count: 5 });
				const products = search.products ?? [];
				if (products.length === 0) {
					await ctx.reply(`No activities found for ${dest.name}. The sandbox catalogue may be limited — try Rome, London, or Paris.`);
					return;
				}

				await ctx.reply(
					`Here are ${products.length} ideas for <b>${dest.name}</b>:`,
					{ parse_mode: "HTML" },
				);
				for (const p of products) {
					const card = formatActivityCard(p, env.VIATOR_AFFILIATE_ID);
					await sendActivityCard(ctx, card);
				}
			} catch (err) {
				const detail = err instanceof ViatorError ? `${err.endpoint} → ${err.status}` : String(err);
				console.error("Viator request failed:", err);
				await ctx.reply(`Hit an error talking to Viator (${detail}). Try again in a moment.`);
			}
		});

		return webhookCallback(bot, "cloudflare-mod")(request);
	},
} satisfies ExportedHandler<Env>;
