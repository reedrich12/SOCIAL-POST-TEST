# Trending-audio scraper

Feeds the orchestrator's music library: fetches a pool of audio tracks and
uploads them to the Cloudflare R2 `music/` prefix. The DockTok orchestrator then
randomly selects a fresh track per job (`resolveMusicTrack` in `server.ts`).

Run it on a schedule (e.g. weekly) so the pool keeps refreshing.

## Setup

```bash
cd scraper
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# yt-dlp also needs ffmpeg on PATH (brew install ffmpeg / apt install ffmpeg)
```

R2 credentials are read from the repo-root `.env.local` (the same vars the app
uses): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`, and optionally `R2_MUSIC_PREFIX` (default `music/`).

## Sources

Set `SCRAPER_SOURCE`:

### `ytdlp` (default, working)
Add one URL per line to `sources.txt`, then:
```bash
python3 fetch_trending_audio.py
```
Each URL's audio is extracted to mp3 and uploaded to the music prefix.

### `rapidapi` (automated trending discovery — integration point)
For hands-off "grab the top trending sounds" automation. Set:
```bash
export SCRAPER_SOURCE=rapidapi
export RAPIDAPI_KEY=...           # your RapidAPI key
export RAPIDAPI_HOST=...          # e.g. tiktok-scraper7.p.rapidapi.com
export RAPIDAPI_TRENDING_URL=...  # the provider's "trending sounds" endpoint
```
Then map the provider's JSON response to `(name, audio_url)` pairs in
`fetch_via_rapidapi()` (marked `TODO`) — the exact shape varies per provider.

## Config

| Env | Default | Purpose |
|-----|---------|---------|
| `SCRAPER_SOURCE` | `ytdlp` | `ytdlp` or `rapidapi` |
| `SCRAPER_MAX_TRACKS` | `50` | Cap on tracks fetched + kept in the prefix (older ones pruned) |
| `R2_MUSIC_PREFIX` | `music/` | R2 prefix to upload into |

## Schedule (weekly cron)

```cron
# Mondays 04:00 — refresh the trending-audio pool
0 4 * * 1 cd /path/to/SOCIAL-POST-TEST/scraper && .venv/bin/python fetch_trending_audio.py >> /tmp/docktok-scraper.log 2>&1
```

## ⚠️ Rights & Terms of Service

Only ingest audio you have the rights to publish. Downloading audio from
TikTok / Instagram / YouTube may violate their Terms of Service and copyright.
You are responsible for what you upload and publish.
