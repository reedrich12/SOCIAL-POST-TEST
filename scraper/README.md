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

### `rapidapi` (automated trending discovery)
Hands-off "grab the top trending sounds" automation via the **"Tiktok Scraper"**
provider by **tikwm** on RapidAPI (free Basic plan: 300 req/month — a weekly run
uses ~4). Configure in `.env.local`:
```bash
SCRAPER_SOURCE="rapidapi"
RAPIDAPI_KEY="..."                                                  # keep only in .env.local
RAPIDAPI_HOST="tiktok-scraper7.p.rapidapi.com"
RAPIDAPI_TRENDING_URL="https://tiktok-scraper7.p.rapidapi.com/feed/list?region=us&count=40"
```
Then run `python3 fetch_trending_audio.py`.

How it works: tikwm's dedicated *Get Trending Sound* endpoint is **deprecated**, so
we pull the live **For-You-Page feed** (`/feed/list`) instead. Every FYP video
carries a `music_info` object with a playable audio URL (`data[].music_info.play`,
fallback `data[].music`); the scraper extracts those sounds, **dedupes by music id**,
and ranks by the video's `play_count` (most-trending first). Request more videos
than `SCRAPER_MAX_TRACKS` (the default URL uses `count=40`) since multiple videos
can share one sound.

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
