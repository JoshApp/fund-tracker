# Stolen-Fund Tracker (Case: on-chain CRO fraud)

A free, self-hosted tracker for the laundered funds across **Cronos** and **Ethereum**.

- **`index.html`** — a live dashboard (balances, money-flow map, movement feed, value-over-time chart, on-page alerts). Hosted for free on **GitHub Pages**.
- **`scripts/poll.mjs` + `.github/workflows/track.yml`** — a scheduled **GitHub Action** that runs every ~15 minutes, appends a snapshot to **`data/history.json`**, and sends a **Telegram alert** when any watched wallet's value moves by ≥ the threshold (default **$2,000**).

No server, no database, no cost.

---

## Setup (about 10 minutes, all in the browser)

### 1. Create the repository
- Go to **github.com → New repository**. Name it e.g. `fund-tracker`. Make it **Public** (needed for free unlimited Actions + Pages). Create it.
- On the empty repo page, click **“uploading an existing file”** and drag in **all the files in this folder** (keep the folder structure: `index.html`, `data/`, `scripts/`, `.github/`). Commit.

### 2. Turn on GitHub Pages (the website)
- Repo → **Settings → Pages**.
- Under **Build and deployment → Source**, pick **Deploy from a branch**.
- Branch: **`main`**, folder: **`/ (root)`**. Save.
- After a minute your site is live at `https://<your-username>.github.io/fund-tracker/` — send that link to whoever should watch it.

### 3. Set up Telegram alerts (so you're pinged even when nobody's watching)
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → it gives you a **bot token** (looks like `123456:ABC-...`).
2. Start a chat with your new bot and send it any message (e.g. “hi”).
3. Get your **chat ID**: open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and copy the `"chat":{"id": ...}` number. (For a group, add the bot to the group and use the group's negative id.)
4. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add two:
   - `TELEGRAM_TOKEN` = your bot token
   - `TELEGRAM_CHAT_ID` = your chat id

*(No Telegram? Skip step 3 — everything else still works; alerts just won't be pushed. The on-page banner + sound + browser notification still work while the site is open.)*

### 4. Enable + test the Action
- Repo → **Actions** tab → if prompted, **enable workflows**.
- Click **track-funds → Run workflow** to run it once now. It should: log a snapshot, commit `data/history.json`, and (if funds moved vs the last snapshot) send a Telegram message.
- From then on it runs automatically every ~15 minutes.

Done. The website updates live in the browser, the chart/history fill in from the Action, and you get a Telegram alert on every big move.

---

## Customising
- **Alert threshold:** edit `ALERT_THRESHOLD_USD` in `.github/workflows/track.yml` (and the box on the page for the live view).
- **Watched wallets:** edit the `W = [...]` list in **both** `scripts/poll.mjs` and `index.html` (keep the `id`s matching).
- **How often:** the `cron: "*/15 * * * *"` line in the workflow (GitHub may delay scheduled runs by a few minutes — normal).

## What each visitor sees
- A one-line **status strip**: *"Where's the money: $X idle · $Y freezable · Did it move? YES/NO."* — the glanceable answer.
- A **"🆕 N new movements since your last visit"** banner. Each movement logged to `data/history.json` gets a sequential **id**; the visitor's browser remembers the **last-seen id** (in localStorage), so anything newer is flagged NEW. Click **Mark all as seen** to reset. This is per-browser, so each person tracks their own "unread" independently — no login, no server.

## Notes
- Data comes straight from public Cronos/Ethereum nodes and block explorers — anyone can verify it.
- History lives in `data/history.json` in this repo (permanent, shared). The live page also keeps a local copy in your browser.
- This is a monitoring aid, not financial or legal advice. It watches a fixed set of addresses; if the funds move to a brand-new wallet, add that address to the `W` list.
