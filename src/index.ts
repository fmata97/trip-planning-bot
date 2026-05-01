import { Bot, webhookCallback } from "grammy";
import type { Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { getAgentByName } from "agents";
import { TripAgent } from "./agent";
import { llamaMarkdownToTelegramHTML, formatPollOption } from "./telegram/format";

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

	// Phase 3 (revised): instead of N cards with inline buttons, post a
	// single native Telegram poll. Better group-chat UX and lets us tally
	// via stopPoll() at /finalize.
	if (reply.cards.length > 0) {
		// Telegram caps polls at 10 options.
		const slice = reply.cards.slice(0, 10);
		const options = slice.map((c) => formatPollOption(c));
		const productCodes = slice.map((c) => c.productCode);
		const question = `Which to book?${reply.cards.length > 10 ? ` (top ${slice.length})` : ""}`;
		try {
			const pollMsg = await ctx.replyWithPoll(question, options, {
				is_anonymous: false,
				allows_multiple_answers: true,
			});
			const pollId = pollMsg.poll?.id;
			if (pollId) {
				await agent.registerPoll({
					chatId,
					messageId: pollMsg.message_id,
					pollId,
					productCodes,
					question,
				});
			}
		} catch (err) {
			console.error("sendPoll failed", { err: String(err) });
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
			const poll = await agent.getActivePoll();

			let summary;
			if (poll) {
				try {
					const stopped = await ctx.api.stopPoll(poll.chatId, poll.messageId);
					const voteCountsByOption = stopped.options.map((o) => o.voter_count ?? 0);
					summary = await agent.finalizeFromPoll(voteCountsByOption);
				} catch (err) {
					console.error("stopPoll failed", String(err));
					// Poll might already be closed — fall back to legacy tally
					summary = await agent.finalize();
				}
			} else {
				summary = await agent.finalize();
			}

			await ctx.reply(llamaMarkdownToTelegramHTML(summary.text), {
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
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
