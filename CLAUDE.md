# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DockTok Orchestrator** is a video pipeline dashboard. It accepts a Cloudflare R2 asset ID, runs it through a four-stage pipeline (R2 download → FFmpeg mux/fingerprint → OpenAI caption generation → Zernio cross-platform publish to TikTok/Instagram), and surfaces job status in a real-time React dashboard.

This is a Google AI Studio app (see `metadata.json`, README banner). The AI Studio runtime injects `GEMINI_API_KEY` and `APP_URL` automatically at runtime.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev server: Express + Vite middleware on http://localhost:3000
npm run build        # vite build (client → dist/) + esbuild bundle (server → dist/server.cjs)
npm run start        # Run production build (NODE_ENV=production node dist/server.cjs)
npm run preview      # Vite preview of the built client
npm run lint         # Type-check only (tsc --noEmit) — there is no ESLint
npm run clean        # Remove dist/ and server.js
```

There is no test runner configured. `npm run lint` is type-checking, not linting.

## Architecture

**Single-process, full-stack.** `server.ts` is the entry point for both dev and prod — there is no separate frontend dev server.

- **Dev** (`NODE_ENV !== 'production'`): Express mounts Vite in `middlewareMode` as SPA, so the API and the React app are served from the same port (3000). `tsx` runs `server.ts` directly.
- **Prod**: Express serves static files from `dist/` with an SPA catch-all. The server is bundled to a single `dist/server.cjs` via esbuild (`--packages=external`, so `node_modules` must be present at runtime).

**Request flow:**
- `POST /api/trigger` — inserts a `jobs` row (status `processing`), responds immediately with `{ jobId }`, then runs `processJob()` asynchronously. The HTTP request does NOT wait for the pipeline.
- `GET /api/jobs` — returns the 50 most recent jobs, newest first.
- Frontend (`src/App.tsx`) polls `GET /api/jobs` every 2.5s to reflect status changes; there are no websockets.

**`processJob()` pipeline** advances the row's `status` through `fetching_r2` → `muxing_ffmpeg` → `generating_captions` → `publishing_zernio` → `completed`, writing the generated caption and the processed-video `result_url` to the DB along the way. Each stage runs its real integration when its credentials are present, and **falls back to a short `wait()` mock delay otherwise** — so the whole flow completes end-to-end with no keys configured (caption defaults, `result_url` stays null). Stages and their gates:
1. **fetching_r2** — `downloadFromR2()` streams the R2 object (`assetId` = object key) to a temp file (gate: `getS3Client()`, i.e. `R2_ACCOUNT_ID`).
2. **muxing_ffmpeg** — `resolveMusicTrack()` picks a random track from the R2 music prefix (`R2_MUSIC_PREFIX`, default `music/`, fed by the trending-audio scraper) and downloads it; falls back to the local `MUSIC_DIR` (default `assets/music/`). `transcodeAndFingerprint()` re-encodes via `fluent-ffmpeg`, strips metadata, applies a sub-perceptual color shift so the output hash differs from the source, and muxes the (looped, `-shortest`-trimmed) track in as audio. Video-only if no track anywhere (gate: a downloaded source file exists).
3. **generating_captions** — `generateCaption()` calls OpenAI chat completions (gate: `getOpenAIClient()`; model via `OPENAI_MODEL`, default `gpt-4o-mini`).
4. **publishing_zernio** — archives the processed file to R2 under `processed/<jobId>.mp4` + stores a presigned preview URL as `result_url`, then `publishViaZernio()` runs the real Zernio flow (verified against the OpenAPI spec at `zernio.com/openapi.yaml`): resolve account IDs via `GET /accounts` or `ZERNIO_*_ACCOUNT_ID` → `POST /media/presign` `{filename, contentType}` → `PUT` bytes to `uploadUrl` (no auth) → `POST /posts` `{content, mediaItems:[{url, type:"video"}], platforms, publishNow:true, tiktokSettings}` with an `x-request-id` idempotency header. Response `201 {post:{_id, platforms[].platformPostUrl}}`. Gate: `ZERNIO_API_KEY` + a processed file; base URL via `ZERNIO_API_URL` (default `https://zernio.com/api/v1`). **Requires connected IG/TikTok accounts in Zernio.** Note: IG Reels need vertical 9:16 ≤90s video; landscape posts as a feed video (Zernio auto-detects).

`/api/trigger` accepts `{ assetId, dryRun, vertical }`. `dryRun: true` runs the full chain (download → mux → caption → R2 archive) but skips the live publish and ends in status `dry_run_complete` — the safe way to test. `vertical: true` (default from `FORCE_VERTICAL`) renders a 1080×1920 9:16 blurred-pad canvas for Reels/TikTok. Both are also dashboard toggles. On any throw the job is marked `status='error'` with `error_message`; temp files (including the downloaded music) are cleaned up in a `finally`.

## Trending-audio scraper (`scraper/`)

A standalone Python tool (`fetch_trending_audio.py`) that fetches audio and uploads it to the R2 music prefix the orchestrator pulls from — run on a weekly cron to keep the pool fresh. Sources via `SCRAPER_SOURCE`: `ytdlp` (working; reads `scraper/sources.txt`) or `rapidapi` (trending-discovery integration point, needs `RAPIDAPI_*` env + a response-mapping TODO). Reads the repo-root `.env.local` for R2 creds. See `scraper/README.md`. It is decoupled from the Node app — they communicate only through the R2 bucket.

**Persistence:** SQLite via `better-sqlite3` (synchronous, WAL mode) at `orchestrator.db` in the cwd. The DB file is gitignored implicitly (not tracked). Schema is a single `jobs` table created at boot.

## Configuration

Copy `.env.example` to `.env.local`. Keys are read from `process.env` (the AI Studio runtime / dotenv supplies them). Each external integration is optional and gated by presence of its env vars — the app runs end-to-end in mock mode with none set:
- `GEMINI_API_KEY`, `APP_URL` — injected by AI Studio
- `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` — Cloudflare R2 (S3-compatible)
- `OPENAI_API_KEY` — caption generation (optional `OPENAI_MODEL`, default `gpt-4o-mini`)
- `ZERNIO_API_KEY` — publishing (optional `ZERNIO_API_URL`, default `https://api.zernio.com/v1`)
- `PORT` — server port (default 3000; Cloud Run / AI Studio inject this)

## Stack

React 19 + Vite 6, Tailwind CSS v4 (via `@tailwindcss/vite`, configured in `src/index.css` with `@theme`, not a `tailwind.config`), TypeScript (bundler resolution, `allowImportingTsExtensions`, `noEmit`), Express 4, lucide-react icons. The `@/*` path alias maps to the repo root.
