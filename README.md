# Stoat Soundboard

Self-hosted soundboard for [Stoat](https://stoat.chat) (and any Stoat-compatible instance) — upload audio files, organize by categories, and trigger them in text channels or live in voice channels via [LiveKit](https://livekit.io).

Built on [`stoat.js`](https://github.com/stoatchat/javascript-client-sdk) and [`revoice.js`](https://github.com/ShadowLp174/revoice.js), with a clean web UI and a single Docker container. Based on [awesome-stoat](https://github.com/stoatchat/awesome-stoat).

![Soundboard UI](https://img.shields.io/badge/UI-English%20%7C%20Voice%20%7C%20Categories-7c5cff)

## Features

- **Web UI** — drag & drop upload, preview, search, category filters, login with password
- **Categories** — group sounds (e.g. General, V1, V2, Out of Context) with filter bar
- **Text playback** — bot posts the audio file as an attachment in any text channel
- **Voice playback** — bot joins a voice channel and streams the audio live (ffmpeg → LiveKit)
- **Auto-leave** — voice disconnects after 5-10 min idle
- **Bot commands** — `!sb` prefix for add/list/play/delete/rename and voice controls
- **Single container** — bot + web UI share `./sounds` volume, `sounds.json` registry
- **Secure** — optional `WEB_PASSWORD` (`X-Token`), HTTPS-ready via reverse proxy or Cloudflare Tunnel

## Quick Start (local)

```bash
git clone https://github.com/mbaus24/stoat-soundboard-bot.git
cd stoat-soundboard-bot
cp .env.example .env
# edit .env: BOT_TOKEN, STOAT_BASE_URL, WEB_PASSWORD, DEFAULT_CHANNEL_ID, VOICE_CHANNEL_ID
npm install
npm start
# UI: http://localhost:3000
# Health: GET http://localhost:3000/api/health
```

Create a bot at your Stoat instance → copy token → invite it with `Send Message` + `Upload Files` + `Connect` + `Speak` (for voice).

Get a **Channel ID**: Stoat → Settings → Appearance → Developer Mode → right-click channel → Copy ID.

## Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
docker logs -f stoat-soundboard
```

`docker-compose.yml` exposes `${WEB_PORT:-3000}:3000` and mounts `./sounds:/app/sounds`.

Any Docker host works — NAS, VPS, Raspberry Pi, etc. For TrueNAS Scale: Apps → Custom App → paste `docker-compose.yml`.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | *required* | Bot token |
| `STOAT_BASE_URL` | `https://stoat.chat/api` | Instance API URL (e.g. `https://trans.girls.rocks/api`) |
| `PREFIX` | `!sb` | Command prefix |
| `WEB_PORT` | `3000` | Web UI port |
| `WEB_PASSWORD` | *(empty)* | Password for UI/API (`X-Token` header or `?token=`) |
| `DEFAULT_CHANNEL_ID` | *(empty)* | Default text channel for `▶ Send` |
| `VOICE_CHANNEL_ID` | *(empty)* | Default voice channel for `🔊 Voice` |
| `MAX_FILE_SIZE_MB` | `8` | Max upload size |

## Usage

### Web UI (recommended)

- Open `http://YOUR_SERVER:3000` → enter `WEB_PASSWORD` → `Unlock`
- Top: stylish **Text** / **Voice** channel selectors (grouped by server, `#` / `🔊` icons, paste ID fallback)
- **Upload**: name `a-z0-9_-` (1-30 chars) + category + drag file → `Upload` → preview via `<audio>`
- **Play**: `▶ Send` posts `🔊 name` + file in the selected text channel; `🔊 Voice` joins the selected voice channel and streams live
- **Voice controls**: `Join Voice` / `Leave` / `⏹ Stop` — bot auto-leaves after 5-10 min idle
- **Manage**: `Delete` / `Rename`, search, category filter (`All` / `General` / `V1` ...)

### Bot Commands

- `!sb help` — help
- `!sb list` — list sounds
- `!sb add <name>` + attachment — add (also via UI)
- `!sb play <name>` or `!sb <name>` — post in text
- `!sb delete <name>` / `!sb rename <old> <new>`
- `!sb vjoin [voiceChannelId]` — join voice (auto if you're in one)
- `!sb vplay <name> [voiceChannelId]` — play in voice
- `!sb vleave` / `!sb vstop`

Uploads via UI and via `!sb add` share the same storage (`./sounds` + `sounds.json`).

## API

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | no | `botReady`, `sounds` count |
| `GET` | `/api/sounds` | `X-Token` if set | list + `categories` |
| `POST` | `/api/sounds` | `X-Token` | `form: name, category, file` |
| `DELETE` | `/api/sounds/:name` | `X-Token` | delete |
| `POST` | `/api/sounds/:name/rename` | `X-Token` | `{newName}` |
| `POST` | `/api/play/:name` | `X-Token` | `{channelId}` text |
| `POST` | `/api/voice/play/:name` | `X-Token` | `{channelId}` voice |
| `POST` | `/api/voice/join` | `X-Token` | `{channelId}` |
| `POST` | `/api/voice/leave` | `X-Token` | `{channelId}` |
| `GET` | `/api/channels` | `X-Token` | servers + channels for selectors |
| `GET` | `/sounds/:filename` | no | preview |

Auth: `X-Token: WEB_PASSWORD` or `?token=` or `Authorization: Bearer`.

## Voice

Powered by `revoice.js` + `@livekit/rtc-node` + `ffmpeg-static`. Requires `Connect` + `Speak` permission in the voice channel. The web UI and `!sb vplay` both use the same LiveKit flow (`join` → `play` → `MediaPlayer.playStream`).

If `AlreadyConnected` appears after a restart, the previous LiveKit session is stale — wait 30-40s or kick the bot from the voice channel in the UI and re-`Join`.

## Project Structure

```
src/index.js   # start bot + web
src/bot.js     # stoat.js Client, text handlePlay
src/voice.js   # revoice LiveKit, join/play/leave, idle timers
src/sounds.js  # registry
src/server.js  # Express + multer + API
public/index.html # UI (login, channel selectors, categories)
sounds/        # audio + sounds.json (Docker volume)
```

## Reverse Proxy / HTTPS

No port to open for the bot (outbound WebSocket only). For the UI, use a reverse proxy:

- **Caddy + DuckDNS** example in `caddy-duckdns/` (DNS-01 Let's Encrypt)
- **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:3000`) → `https://xxx.trycloudflare.com` (zero open ports) + optional Cloudflare Access

Always set `WEB_PASSWORD` when exposing publicly.

## Troubleshooting

- `Missing BOT_TOKEN` — check `.env` (`docker compose config`)
- `channel_not_found` — wrong ID or bot not in server
- `bot_not_ready` — wait for `ready` log, check token + `STOAT_BASE_URL`
- `401 Unauthorized` — wrong `WEB_PASSWORD` (`X-Token`)
- Upload rejected — check `audio/*` MIME and `MAX_FILE_SIZE_MB`
