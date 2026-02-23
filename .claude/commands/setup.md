Guide the user through setting up their BAREclaw instance. This is a first-run setup flow.

## Steps

### 1. Check prerequisites
Verify that the `.env` file exists and has the required variables configured:
- `BARECLAW_TELEGRAM_TOKEN` (if they want Telegram)
- `BARECLAW_ALLOWED_USERS` (required for Telegram)
- `BARECLAW_HTTP_TOKEN` (recommended for HTTP auth)

If `.env` doesn't exist, copy `.env.example` and walk them through filling it in.

### 2. Personalize SOUL.md
Read the existing `SOUL.md` — it defines your core personality and engineering principles. Ask the user if they want to add a personal section at the top. Things to ask about:

- **Name**: Do they want to call you something specific?
- **Tone adjustments**: More casual? More technical? Different from the defaults?
- **Boundaries**: Things you should never do without asking (e.g., git push, delete files, deploy to prod)
- **Context**: What they're working on, what kind of tasks they'll typically send you

If they want changes, add a `## Personal` section near the top of SOUL.md with their preferences. Don't overwrite the existing personality or engineering principles — those are the project defaults.

If they're happy with the defaults, move on.

### 3. Install heartbeat
Run `bash heartbeat/install.sh` to set up the heartbeat scheduled job. Confirm it installed successfully.

### 4. Start the server
If not already running, start with `npm run dev`. Verify it starts successfully.

### 5. Test connectivity
If Telegram is configured, send a test message via `POST /send` to confirm the bot can reach them.

## Important
- Be conversational during setup — this is the user's first impression of their agent.
- Don't dump all questions at once. Ask them one topic at a time.
- If they seem impatient, offer to use sensible defaults and let them customize later.
