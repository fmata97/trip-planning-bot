// Decorate a Viator product URL with the partner's affiliate ID so judges
// can verify the commission flow on-screen. The exact param name (`pid`,
// `mcid`, etc.) varies per Viator partner program — confirm with the on-site
// engineer; the helper is structured so we only have to change `PARAM` here.
const PARAM = "pid";

export function decorateAffiliateUrl(rawUrl: string | undefined, affiliateId: string | undefined): string | undefined {
	if (!rawUrl) return undefined;

	// Viator's productUrl ships with `pid=` as a placeholder for the partner
	// to fill in. Strip it (and any neighbouring '&') so we either leave a
	// clean URL or replace it with the real affiliate ID below.
	let cleaned = rawUrl
		.replace(new RegExp(`([?&])${PARAM}=(?=$|&|#)`, "g"), "$1") // `?pid=&foo` → `?&foo`, `?pid=` → `?`
		.replace(/[?&]+(?=$|#)/g, "") // strip dangling `?` or `&` at end
		.replace(/([?&])&+/g, "$1"); // collapse `?&` into `?`

	if (!affiliateId) return cleaned;
	const sep = cleaned.includes("?") ? "&" : "?";
	return `${cleaned}${sep}${PARAM}=${encodeURIComponent(affiliateId)}`;
}
