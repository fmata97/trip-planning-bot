// Decorate a Viator product URL with the partner's affiliate ID so judges
// can verify the commission flow on-screen. The exact param name (`pid`,
// `mcid`, etc.) varies per Viator partner program — confirm with the on-site
// engineer; the helper is structured so we only have to change `PARAM` here.
const PARAM = "pid";

// Idempotent: strips any existing `pid` (placeholder OR already-set) and
// either leaves it absent (no affiliateId) or sets it to ours. Uses the
// URL API rather than regex so multi-param edge cases stay correct.
export function decorateAffiliateUrl(rawUrl: string | undefined, affiliateId: string | undefined): string | undefined {
	if (!rawUrl) return undefined;
	try {
		const u = new URL(rawUrl);
		u.searchParams.delete(PARAM);
		if (affiliateId && affiliateId.length > 0) {
			u.searchParams.set(PARAM, affiliateId);
		}
		return u.toString();
	} catch {
		return rawUrl;
	}
}
