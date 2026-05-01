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

// Per viator_api_endpoints.md: prefer recommendedRetailPrice for user-facing
// "from" prices. Final available prices must come from /availability/check —
// not used at this stage. Try a few common shapes for the nested field.
function extractPrice(p: ViatorProduct): { amount: number; currency: string } | null {
	const rrp = p.recommendedRetailPrice as
		| { fromPrice?: number; amount?: number; price?: number; currency?: string; currencyCode?: string }
		| undefined;
	if (rrp) {
		const amount = rrp.fromPrice ?? rrp.amount ?? rrp.price;
		if (typeof amount === "number") {
			return { amount, currency: rrp.currency ?? rrp.currencyCode ?? "USD" };
		}
	}
	const pricing = p.pricing as { summary?: { fromPrice?: number }; currency?: string } | undefined;
	if (typeof pricing?.summary?.fromPrice === "number") {
		return { amount: pricing.summary.fromPrice, currency: pricing.currency ?? "USD" };
	}
	return null;
}

function formatPrice(p: ViatorProduct): string {
	const v = extractPrice(p);
	if (!v) return "Price on Viator";
	return `from ${v.currency} ${v.amount.toFixed(0)}`;
}

function formatRating(p: ViatorProduct): string {
	const rating = p.rating ?? p.reviews?.combinedAverageRating;
	const count = p.reviewCount ?? p.reviews?.totalReviews;
	if (!rating) return "";
	return `⭐ ${rating.toFixed(1)}${count ? ` (${count})` : ""}`;
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
	// Spec: preserve productUrl for attribution. webURL is legacy v1.
	const url = decorateAffiliateUrl(product.productUrl, affiliateId);

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
