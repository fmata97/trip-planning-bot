// Viator's Partner API returns productUrl already attributed to the partner
// (the relationship is tied to the API key). In normal operation we just
// pass productUrl through. This helper exists only as a fallback for the
// edge case where Viator returns a URL with no `pid` set — then we add ours.
const PARAM = "pid";

export function decorateAffiliateUrl(rawUrl: string | undefined, affiliateId: string | undefined): string | undefined {
	if (!rawUrl) return undefined;
	try {
		const u = new URL(rawUrl);
		const existing = u.searchParams.get(PARAM);
		// Already attributed (real value, not placeholder) — trust Viator.
		if (existing && existing.length > 0) return u.toString();
		// No pid (or empty placeholder) and we have one to set — add it.
		u.searchParams.delete(PARAM);
		if (affiliateId && affiliateId.length > 0) {
			u.searchParams.set(PARAM, affiliateId);
		}
		return u.toString();
	} catch {
		return rawUrl;
	}
}
