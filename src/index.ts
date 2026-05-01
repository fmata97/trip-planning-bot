import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { getAgentByName } from "agents";
import { TripAgent } from "./agent";
import { llamaMarkdownToTelegramHTML, formatPollOption, sendActivityCardWithLink } from "./telegram/format";

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

	// When the agent proposed activities this turn, render them as one card
	// per activity (image + title + Book on Viator link) followed by a poll
	// whose options are index-aligned with the cards. The LLM's text summary
	// is suppressed in that case — the cards already say everything, and the
	// LLM text was prone to mangled markdown links.
	if (reply.cards.length > 0) {
		// Telegram caps polls at 10 options, so cap cards too to keep the
		// 1:1 mapping intact.
		const slice = reply.cards.slice(0, 10);

		for (let i = 0; i < slice.length; i++) {
			try {
				await sendActivityCardWithLink(ctx, slice[i], i + 1);
			} catch (err) {
				console.error("sendActivityCardWithLink failed", { i, err: String(err) });
			}
		}

		const options = slice.map((c) => formatPollOption(c));
		const productCodes = slice.map((c) => c.productCode);
		const question = `Vote your picks — then run /finalize${reply.cards.length > 10 ? ` (top ${slice.length})` : ""}`;
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
		return;
	}

	if (reply.text) {
		await ctx.reply(llamaMarkdownToTelegramHTML(reply.text), {
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		});
	}
}

function buildBot(env: Env): Bot {
	const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });

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
					"2. I'll send one card per activity (with a Book on Viator link), then a poll.\n" +
					"3. Vote in the poll, then run <code>/finalize</code> for the winning picks + total cost.\n\n" +
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

	return bot;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === "GET") {
			return new Response("trip-planning-bot is up", { status: 200 });
		}

		const bot = buildBot(env);
		if (!botInfo) {
			await bot.init();
			botInfo = bot.botInfo;
		}

		// Process the update in the background so we can return 200 to
		// Telegram immediately. Without this, slow agent.handleMessage calls
		// (>10s) blow past Telegram's webhook timeout, Telegram retries,
		// and the user sees split messages or duplicates. waitUntil keeps
		// the worker alive for up to 30s after the response is sent.
		try {
			const update = (await request.json()) as Update;
			ctx.waitUntil(
				bot.handleUpdate(update).catch((err) => {
					console.error("bot.handleUpdate failed", String(err));
				}),
			);
		} catch (err) {
			console.error("webhook parse failed", String(err));
		}
		return new Response("OK");
	},
} satisfies ExportedHandler<Env>;
