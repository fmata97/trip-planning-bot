// `wrangler types` only emits bindings declared in wrangler.jsonc; it can't
// see secrets set via `wrangler secret put`. We declaration-merge the secret
// shape here so the rest of the codebase gets compile-time type safety.
interface Env {
	TELEGRAM_BOT_TOKEN: string;
	VIATOR_API_KEY: string;
	VIATOR_AFFILIATE_ID: string;
}
