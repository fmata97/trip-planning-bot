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
