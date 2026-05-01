import { Bot, webhookCallback, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { getAgentByName } from "agents";
import { TripAgent } from "./agent";
import { llamaMarkdownToTelegramHTML, sendCandidateCard, buildVoteKeyboard } from "./telegram/format";

export { TripAgent };

// Cache bot info across requests (per grammY Workers guide).
let botInfo: UserFromGetMe | undefined;

async function getAgent(env: Env, chatId: number) {
	return await getAgentByName<Env, TripAgent>(env.TRIP_AGENT, `chat-${chatId}`);
}

async function replyWithAgent(ctx: Context, env: Env, text: string): Promise<void> {
	const chatId = ctx.chat?.id;
	const userId = ctx.from?.id;
	if (!chatId || !userId) return;
	await ctx.replyWithChatAction("typing").catch(() => {}); // best-effort

	const agent = await getAgent(env, chatId);
	const reply = await agent.handleMessage(text, userId);

	if (reply.text) {
		await ctx.reply(llamaMarkdownToTelegramHTML(reply.text), {
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		});
	}

	// Phase 3: render one Telegram card per candidate proposed this turn,
	// with vote buttons. Sequential to preserve order; each is its own message.
	for (const card of reply.cards) {
		const counts = await agent.getVoteCounts(card.productCode);
		try {
			await sendCandidateCard(ctx, card, counts);
		} catch (err) {
			console.error("sendCandidateCard failed", { productCode: card.productCode, err: String(err) });
		}
	}
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
					"<b>How it works:</b>\n" +
					"1. Tell me where you're going: <code>/plan Lisbon, food and history, 3 days, $100/person</code>\n" +
					"2. I'll send activity cards. Everyone votes 👍 / 👎 on each.\n" +
					"3. Run <code>/finalize</code> for the highest-voted picks + total cost.\n\n" +
					"You can also just chat: <i>plan us 3 days in Rome late May</i>.",
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

		bot.command("finalize", async (ctx) => {
			const chatId = ctx.chat?.id;
			console.log("cmd=/finalize", { chatId });
			if (!chatId) return;
			const agent = await getAgent(env, chatId);
			const summary = await agent.finalize();
			await ctx.reply(llamaMarkdownToTelegramHTML(summary.text), {
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
		});

		// Vote callbacks. callback_data is "v:<productCode>:<up|down>".
		bot.callbackQuery(/^v:(.+):(up|down)$/, async (ctx) => {
			const productCode = ctx.match[1];
			const kind = ctx.match[2] as "up" | "down";
			const chatId = ctx.chat?.id;
			const userId = ctx.from?.id;
			if (!chatId || !userId) {
				await ctx.answerCallbackQuery();
				return;
			}
			const agent = await getAgent(env, chatId);
			const counts = await agent.vote(productCode, String(userId), kind);
			console.log("vote", { chatId, userId, productCode, kind, counts });
			// Refresh the buttons in place to reflect the new tally.
			const newKb = new InlineKeyboard()
				.text(`👍 ${counts.up}`, `v:${productCode}:up`)
				.text(`👎 ${counts.down}`, `v:${productCode}:down`);
			// Preserve the "View on Viator" url button if it was on the original message.
			const original = ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? [];
			for (const row of original.slice(1)) {
				for (const btn of row) {
					if ("url" in btn && btn.url) {
						newKb.row().url(btn.text, btn.url);
					}
				}
			}
			try {
				await ctx.editMessageReplyMarkup({ reply_markup: newKb });
			} catch (err) {
				// Telegram returns "message not modified" if the keyboard happens
				// to match — harmless.
				console.log("editMessageReplyMarkup noop or failed", String(err));
			}
			await ctx.answerCallbackQuery({
				text: kind === "up" ? "👍 noted" : "👎 noted",
			});
			// Use the now-rebuilt keyboard helper for a sanity assertion (no-op runtime).
			void buildVoteKeyboard;
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
