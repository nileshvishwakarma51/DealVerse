# DealVerse — Local MTProto Listener

An always-on listener that runs on your laptop. It stays connected to Telegram
via **your user account** (MTProto), watches your source channels in **real time**,
and pushes every new message to the DealVerse Lambda **ingest** endpoint, which
converts the Amazon/Flipkart links and posts them to your channel instantly.

This replaces waiting for the 5-minute cron: deals go out the moment they're
posted in the source. The cron stays on as a backfill; a shared de-dup means a
deal is never posted twice.

```
Source channel (someone posts) ─▶ this listener (your account) ─▶ Lambda /api/admin/ingest
                                                                        └─▶ convert + publish to your channel
```

## What you need
- **Node.js 18+** (has global `fetch`).
- Your Telegram **api_id** and **api_hash** from https://my.telegram.org → *API development tools*.
- The phone number of a Telegram account that is a **member** of the source channels.
- Your DealVerse admin **name + password**.

## Setup
```bash
cd local-mtproto
npm install
cp .env.example .env        # then edit .env with your values
```

Fill in `.env`:
- `TG_API_ID`, `TG_API_HASH`, `TG_PHONE` — your Telegram user account.
- `DEALVERSE_BASE_URL`, `DEALVERSE_NAME`, `DEALVERSE_PASSWORD` — DealVerse admin login.
- `SOURCES` — optional. Leave empty to watch the **listener channels you already
  configured in the admin panel**; or set a comma-separated list of `@usernames`.

## Run
```bash
npm start
```
On the **first** run it logs you into Telegram: enter the code Telegram sends you
(and your 2FA password if you have one). The session is saved to `.session` so
later runs connect silently — no code needed again.

You'll see logs like:
```
[12:31:02] DealVerse admin: logged in ✓
[12:31:03] Connected to Telegram ✓  Logged in as: @you (+91••••21)
[12:31:03]   monitoring @somechannel ✓
[12:31:03] Listener started ✓  Watching 3 source(s). Keep this window open.
[12:41:19] New message in @somechannel (msg 84213) · 1 link(s)
[12:41:20]   → sent to DealVerse ✓ (posted 2, converted 1)
```

Keep the window open — it works as long as the process runs. It auto-reconnects
if the connection drops. Stop with **Ctrl+C**.

## Deploy to an always-on server (so your laptop can be off)

The listener is **outbound-only** — it needs no open ports / API Gateway to work.
Put it on any tiny always-on Linux box (e.g. an **Oracle Cloud Always-Free VM**, $0)
and run it with **pm2** so it restarts on crash and on reboot.

### 1. Get the code onto the VM
Private repo → either clone with a GitHub token/deploy key, or copy from your laptop:
```bash
scp -r local-mtproto  ubuntu@<vm-ip>:~/       # from your laptop
# ...or on the VM:  git clone <repo-url> && cd <repo>/local-mtproto
```

### 2. Install Node + pm2, configure, run
```bash
# on the VM (Ubuntu):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
cd ~/local-mtproto
cp .env.example .env        # fill DEALVERSE_* ; leave TG_* blank to reuse your
                            # admin Telegram login (fetched from the Lambda).
                            # add EXTRA_SOURCES=... for local-only channels.
npm install --omit=dev
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup                 # run the exact line it prints (enables start-on-boot)
pm2 logs mtproto-listener   # watch it connect + monitor channels
```
That's it — it now runs 24/7 and survives reboots.

### Optional: Docker instead of pm2
```bash
curl -fsSL https://get.docker.com | sudo sh
cd ~/local-mtproto && cp .env.example .env   # edit as above
sudo docker compose up -d --build
sudo docker compose logs -f
```

### Viewing the dashboard remotely
The dashboard stays bound to the server's localhost (not public). Tunnel to it:
```bash
ssh -L 4600:localhost:4600 ubuntu@<vm-ip>
# then open http://localhost:4600 in your browser
```

### ⚠ Run it in only ONE place
Two listeners on the same Telegram login split the update stream and miss
messages. Once the server copy is running, **stop the one on your laptop**.

## Notes / limitations
- It listens only while running. For 24/7 you'd move it to an always-on machine
  (small VPS / Raspberry Pi) — the code is unchanged; just run it there.
- Uses **your user account** to read (not the Bot API) — required to see channels
  you don't own. Don't add channels you can't legitimately access.
- Secrets (`api_hash`, phone, password, Telegram session) live only in your local
  `.env` / `.session`; they're git-ignored and never printed.
