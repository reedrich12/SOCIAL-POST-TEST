#!/usr/bin/env python3
"""
DockTok trending-audio scraper.

Fetches a pool of trending audio tracks and uploads them to the Cloudflare R2
music prefix that the orchestrator pulls from. Designed to run on a schedule
(e.g. a weekly cron) so the music library stays fresh — the PHP/Node orchestrator
then randomly selects a track per job.

Two sources (SCRAPER_SOURCE env):
  - "ytdlp"    (default) — extract audio from a list of source URLs in
                sources.txt using yt-dlp. Fully working.
  - "rapidapi" — discover trending sounds via an unofficial TikTok/Reels
                RapidAPI endpoint, then download them. Integration point: fill in
                your endpoint + response mapping (marked TODO below).

Reuses the same R2_* credentials as the app (.env.local at the repo root).

⚠️  Rights/ToS: only ingest audio you have the rights to publish. Scraping
    platform audio may violate TikTok/Instagram/YouTube Terms of Service and
    copyright. You are responsible for what you upload and publish.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import boto3
import requests
from dotenv import load_dotenv

# Load the repo-root .env.local (same secrets the app uses), then .env.
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / ".env")

R2_ACCOUNT_ID = os.environ["R2_ACCOUNT_ID"]
R2_BUCKET = os.environ.get("R2_BUCKET_NAME", "docktok-assets")
MUSIC_PREFIX = os.environ.get("R2_MUSIC_PREFIX", "music/").rstrip("/") + "/"
MAX_TRACKS = int(os.environ.get("SCRAPER_MAX_TRACKS", "50"))
SOURCE = os.environ.get("SCRAPER_SOURCE", "ytdlp").lower()
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}

# Map Content-Type -> file extension (for downloads) and extension -> Content-Type
# (for R2 uploads). CDN audio URLs are often extension-less, so we derive from
# the response Content-Type when present.
CT_TO_EXT = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav", "audio/x-wav": ".wav",
}
EXT_TO_CT = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
}


def r2_client():
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )


def _slug(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", name).strip("_")[:120]


# --- Source: yt-dlp -----------------------------------------------------------
def fetch_via_ytdlp(out_dir: Path) -> list[Path]:
    """Download audio (mp3) for each URL in scraper/sources.txt via yt-dlp."""
    sources_file = Path(__file__).resolve().parent / "sources.txt"
    if not sources_file.exists():
        print(f"No {sources_file} found. Add one URL per line.", file=sys.stderr)
        return []
    urls = [
        ln.strip()
        for ln in sources_file.read_text().splitlines()
        if ln.strip() and not ln.startswith("#")
    ][:MAX_TRACKS]
    if not urls:
        print("sources.txt is empty.", file=sys.stderr)
        return []

    print(f"yt-dlp: extracting audio from {len(urls)} source(s)...")
    # Prefer the yt-dlp installed alongside this interpreter (venv), else PATH.
    ytdlp = Path(sys.executable).parent / "yt-dlp"
    cmd = [
        str(ytdlp) if ytdlp.exists() else "yt-dlp",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--no-playlist",
        "-o", str(out_dir / "%(title).80s.%(ext)s"),
    ]
    # mp3 conversion needs ffmpeg; point at a specific binary if not on PATH.
    ffmpeg_location = os.environ.get("FFMPEG_LOCATION")
    if ffmpeg_location:
        cmd += ["--ffmpeg-location", ffmpeg_location]
    cmd += urls
    subprocess.run(cmd, check=False)
    return [p for p in out_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS]


# --- Source: RapidAPI (trending discovery) ------------------------------------
def fetch_via_rapidapi(out_dir: Path) -> list[Path]:
    """
    Discover trending sounds via the tikwm "Tiktok Scraper" RapidAPI provider.

    Uses the FYP feed (GET /feed/list) — tikwm's dedicated trending-sound endpoint
    is deprecated, but every FYP video carries a music_info object with a playable
    audio URL, so we extract + dedupe the sounds from the trending feed.

    Set RAPIDAPI_KEY, RAPIDAPI_HOST, RAPIDAPI_TRENDING_URL (see .env.example).
    """
    api_key = os.environ.get("RAPIDAPI_KEY")
    api_host = os.environ.get("RAPIDAPI_HOST")
    trending_url = os.environ.get("RAPIDAPI_TRENDING_URL")
    if not (api_key and api_host and trending_url):
        print(
            "rapidapi source selected but RAPIDAPI_KEY/HOST/TRENDING_URL not set.",
            file=sys.stderr,
        )
        return []

    # The FYP feed can return duplicate sounds, so pull more videos than we need.
    if "count=" not in trending_url:
        sep = "&" if "?" in trending_url else "?"
        trending_url = f"{trending_url}{sep}count={max(MAX_TRACKS * 2, 20)}"

    resp = requests.get(
        trending_url,
        headers={"X-RapidAPI-Key": api_key, "X-RapidAPI-Host": api_host},
        timeout=30,
    )
    if resp.status_code >= 500:
        print(
            f"rapidapi (tikwm): provider error {resp.status_code}; retry later.",
            file=sys.stderr,
        )
        return []
    resp.raise_for_status()
    data = resp.json()

    # --- map tikwm /feed/list response -> [(name, audio_url)] ---
    if isinstance(data, dict) and data.get("code") not in (0, None):
        print(f"rapidapi (tikwm): API returned error code={data.get('code')} "
              f"msg={data.get('msg')!r}", file=sys.stderr)
        return []

    videos = data.get("data") if isinstance(data, dict) else None
    if not isinstance(videos, list):
        print(f"rapidapi (tikwm): unexpected response shape; top-level keys: "
              f"{list(data) if isinstance(data, dict) else type(data)}", file=sys.stderr)
        return []

    # Dedupe sounds by music id, keep the appearance with the highest play_count.
    by_id: dict[str, dict] = {}
    for v in videos:
        if not isinstance(v, dict):
            continue
        mi = v.get("music_info") or {}
        url = mi.get("play") or v.get("music")
        if not url:
            continue
        mid = str(mi.get("id") or url)
        title = mi.get("title") or v.get("title") or mid
        author = mi.get("author") or ""
        name = f"{title} - {author}".strip(" -") or mid
        score = v.get("play_count") or 0
        prev = by_id.get(mid)
        if prev is None or score > prev["score"]:
            by_id[mid] = {"name": name, "url": url, "score": score}

    ranked = sorted(by_id.values(), key=lambda x: x["score"], reverse=True)
    tracks = [(t["name"], t["url"]) for t in ranked][:MAX_TRACKS]

    if not tracks:
        print("rapidapi (tikwm): feed parsed but no audio URLs found.", file=sys.stderr)

    downloaded: list[Path] = []
    for name, url in tracks:
        if not url:
            continue
        try:
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                # Prefer extension from Content-Type; fall back to URL ext, else .mp3.
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                ext = CT_TO_EXT.get(ctype)
                if not ext:
                    url_ext = Path(url.split("?")[0]).suffix.lower()
                    ext = url_ext if url_ext in AUDIO_EXTS else ".mp3"
                dest = out_dir / f"{_slug(name)}{ext}"
                with open(dest, "wb") as fh:
                    for chunk in r.iter_content(8192):
                        fh.write(chunk)
            downloaded.append(dest)
        except Exception as e:  # one bad CDN URL shouldn't abort the run
            print(f"  skip '{name}': {e}", file=sys.stderr)
    return downloaded


def upload_tracks(s3, paths: list[Path]) -> int:
    count = 0
    for p in paths:
        ext = p.suffix.lower()
        key = f"{MUSIC_PREFIX}{_slug(p.stem)}{ext}"
        s3.upload_file(
            str(p), R2_BUCKET, key,
            ExtraArgs={"ContentType": EXT_TO_CT.get(ext, "audio/mpeg")},
        )
        print(f"  uploaded -> {key}")
        count += 1
    return count


def prune_to_max(s3) -> None:
    """Keep only the newest MAX_TRACKS objects under the music prefix."""
    objs = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=MUSIC_PREFIX).get("Contents", [])
    objs = [o for o in objs if Path(o["Key"]).suffix.lower() in AUDIO_EXTS]
    if len(objs) <= MAX_TRACKS:
        return
    objs.sort(key=lambda o: o["LastModified"], reverse=True)
    for o in objs[MAX_TRACKS:]:
        s3.delete_object(Bucket=R2_BUCKET, Key=o["Key"])
        print(f"  pruned -> {o['Key']}")


def main() -> int:
    s3 = r2_client()
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        if SOURCE == "rapidapi":
            tracks = fetch_via_rapidapi(out_dir)
        else:
            tracks = fetch_via_ytdlp(out_dir)

        if not tracks:
            print("No tracks fetched; nothing to upload.")
            return 1

        print(f"Uploading {len(tracks)} track(s) to {R2_BUCKET}/{MUSIC_PREFIX} ...")
        n = upload_tracks(s3, tracks)
        prune_to_max(s3)
        print(f"Done. {n} track(s) now feeding the music library.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
