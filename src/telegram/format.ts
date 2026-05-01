import type { Context, InlineKeyboard } from "grammy";
import { InlineKeyboard as Keyboard } from "grammy";
import type { ViatorProduct } from "../tools/viator";
import { decorateAffiliateUrl } from "../affiliate";

// Pick a reasonably-sized image (Telegram sendPhoto wants ≤10MB and prefers
// width ≥400). Viator often returns multiple variants per image; we grab one
// that's in the 400-800px range.
function pickImageUrl(product: ViatorProduct): string | undefined {
	const variants = product.images?.[0]?.variants ?? [];
	const sorted = [...variants].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
	const ideal = sorted.find((v) => (v.width ?? 0) >= 400 && (v.width ?? 0) <= 800);
	return (ideal ?? sorted[sorted.length - 1] ?? variants[0])?.url;
}

function htmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Convert the markdown that Llama emits into Telegram-flavoured HTML so it
// actually renders. We HTML-escape first so any literal `<>&` from the
// model become entities, then turn markdown syntax into <b>/<i> tags and
// bullet markers into "•".
export function llamaMarkdownToTelegramHTML(input: string): string {
	let s = htmlEscape(input);
	// Markdown links: [text](url) — must come before bold/italic so the URL
	// isn't munged. URL was already html-escaped, &amp; in URLs is fine.
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
	// Headers: Telegram has no <h1>; render as bold on their own line.
	s = s.replace(/^#{1,6}\s+(.+?)\s*$/gm, "<b>$1</b>");
	// Bold: **text** or __text__
	s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
	s = s.replace(/__([^_\n]+?)__/g, "<b>$1</b>");
	// Italic: *text* or _text_ (only when not part of bold/url)
	s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");
	s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<i>$2</i>");
	// Inline code: `code`
	s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
	// Bullet markers at line start
	s = s.replace(/^\s*[-*]\s+/gm, "• ");
	return s;
}

function formatPrice(p: ViatorProduct): string {
	const from = p.pricing?.summary?.fromPrice;
	const cur = p.pricing?.currency ?? "USD";
	if (typeof from !== "number") return "Price on Viator";
	return `from ${cur} ${from.toFixed(0)}`;
}

function formatRating(p: ViatorProduct): string {
	const r = p.reviews?.combinedAverageRating;
	const n = p.reviews?.totalReviews;
	if (!r) return "";
	return `⭐ ${r.toFixed(1)}${n ? ` (${n})` : ""}`;
}

export interface FormattedCard {
	imageUrl?: string;
	caption: string;
	keyboard: InlineKeyboard;
}

export function formatActivityCard(product: ViatorProduct, affiliateId: string | undefined): FormattedCard {
	const title = htmlEscape(product.title);
	const desc = htmlEscape(product.shortDescription ?? product.description ?? "").slice(0, 300);
	const price = formatPrice(product);
	const rating = formatRating(product);
	const duration = product.duration?.description ?? "";
	const url = decorateAffiliateUrl(product.productUrl ?? product.webURL, affiliateId);

	// Telegram caption hard-cap: 1024 chars. Keep this comfortably under.
	const lines: string[] = [`<b>${title}</b>`];
	const meta = [price, rating, duration].filter(Boolean).join(" · ");
	if (meta) lines.push(`<i>${htmlEscape(meta)}</i>`);
	if (desc) lines.push(desc);
	const caption = lines.join("\n").slice(0, 1024);

	const keyboard = new Keyboard();
	if (url) keyboard.url("🔗 View on Viator", url);

	return { imageUrl: pickImageUrl(product), caption, keyboard };
}

export async function sendActivityCard(ctx: Context, card: FormattedCard): Promise<void> {
	if (card.imageUrl) {
		await ctx.replyWithPhoto(card.imageUrl, {
			caption: card.caption,
			parse_mode: "HTML",
			reply_markup: card.keyboard,
		});
	} else {
		await ctx.reply(card.caption, {
			parse_mode: "HTML",
			reply_markup: card.keyboard,
			link_preview_options: { is_disabled: true },
		});
	}
}
