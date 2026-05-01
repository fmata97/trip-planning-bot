# Trip Planning Bot

A Telegram group chat bot that helps friends plan trips together by discovering, voting on, and booking Viator tours and activities — powered by AI.

Built on Cloudflare Workers with a persistent AI agent per chat group.

## Demo

[![Watch the demo](https://img.youtube.com/vi/0TyANoptT9U/maxresdefault.jpg)](https://youtu.be/0TyANoptT9U)

## How It Works

1. Tell the bot where you're going: `/plan Lisbon, food and history, 3 days, $100/person`
2. The bot searches Viator and sends activity cards with images and booking links
3. A poll follows so your group can vote on favorites
4. Run `/finalize` to see the winning picks and total cost

## Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **AI:** Workers AI (Llama 4 Scout) via Vercel AI SDK
- **State:** Durable Objects with SQLite (persistent per-chat agent)
- **Telegram:** grammY framework
- **Activities:** Viator Partner API

## Commands

| Command           | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `/start`          | Onboarding message explaining the workflow                            |
| `/plan <details>` | Search for activities (e.g. `/plan Tokyo, 2 days, street food`)       |
| `/finalize`       | Stop the poll, tally votes, and show the winning itinerary with costs |
| `/ping`           | Health check                                                          |

Any plain text message in the chat is also forwarded to the AI agent for conversational planning.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Viator Partner API](https://docs.viator.com/) key

### Install dependencies

```sh
npm install
```

### Configure secrets

Create a `.dev.vars` file for local development:

```
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
VIATOR_API_KEY=your-viator-api-key
VIATOR_AFFILIATE_ID=your-affiliate-id
```

For production, set secrets via Wrangler:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put VIATOR_API_KEY
npx wrangler secret put VIATOR_AFFILIATE_ID
```

### Authenticate with Cloudflare

```sh
npx wrangler login
```

### Run locally

```sh
npm run dev
```

### Deploy

```sh
npm run deploy
```

After deploying, set your Telegram webhook to point to your worker URL:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<YOUR_WORKER>.workers.dev
```

## Project Structure

```
src/
  index.ts              # Webhook handler, bot commands, message routing
  agent.ts              # TripAgent — persistent per-chat AI agent with state
  prompt.ts             # System prompt for the LLM
  env.d.ts              # Environment type definitions
  tools/
    index.ts            # AI tool definitions (searchActivities, getActivityDetails, setTripDetails)
    viator.ts           # Viator API client
  telegram/
    format.ts           # Telegram message formatting and card rendering
  affiliate.ts          # Affiliate link decoration
wrangler.jsonc          # Cloudflare Workers configuration
```

## Architecture

- **One agent per group chat** — each Telegram group gets its own Durable Object that persists conversation history, trip details, and activity candidates across restarts and deploys.
- **Async webhook processing** — returns 200 to Telegram immediately and processes the update in the background via `waitUntil()`, avoiding timeouts on slow AI calls.
- **Tool-calling loop** — the LLM can call tools (search activities, get details, set trip info) in up to 6 steps per turn.
- **Native Telegram polls** — uses Telegram's built-in poll feature for accurate group voting instead of inline button callbacks.
- **Pre-formatted output** — activity search results include a ready-to-use markdown line that the LLM copies verbatim, ensuring consistent formatting and correct booking links.

## Scripts

| Script               | Description                          |
| -------------------- | ------------------------------------ |
| `npm run dev`        | Start local development server       |
| `npm run deploy`     | Deploy to Cloudflare Workers         |
| `npm test`           | Run tests with Vitest                |
| `npm run cf-typegen` | Generate Cloudflare type definitions |
