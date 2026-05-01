// Decorate a Viator product URL with the partner's affiliate ID so judges
// can verify the commission flow on-screen. The exact param name (`pid`,
// `mcid`, etc.) varies per Viator partner program — confirm with the on-site
// engineer; the helper is structured so we only have to change `PARAM` here.
const PARAM = "pid";

export function decorateAffiliateUrl(rawUrl: string | undefined, affiliateId: string | undefined): string | undefined {
	if (!rawUrl) return undefined;
	if (!affiliateId) return rawUrl;
	const sep = rawUrl.includes("?") ? "&" : "?";
	return `${rawUrl}${sep}${PARAM}=${encodeURIComponent(affiliateId)}`;
}
