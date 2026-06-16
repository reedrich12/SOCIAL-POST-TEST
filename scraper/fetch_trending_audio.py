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
    # Requires yt-dlp + ffmpeg on PATH (see requirements.txt / README).
    subprocess.run(
        [
            "yt-dlp",
            "--extract-audio",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "--no-playlist",
            "-o", str(out_dir / "%(title).80s.%(ext)s"),
            *urls,
        ],
        check=False,
    )
    return [p for p in out_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS]


# --- Source: RapidAPI (trending discovery) ------------------------------------
def fetch_via_rapidapi(out_dir: Path) -> list[Path]:
    """
    Discover trending sounds via a RapidAPI TikTok/Reels endpoint, then download.

    INTEGRATION POINT — set:
      RAPIDAPI_KEY, RAPIDAPI_HOST, RAPIDAPI_TRENDING_URL
    and map the response to a list of (name, audio_url) below. The exact JSON
    shape depends on the provider you choose, hence the TODO.
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

    resp = requests.get(
        trending_url,
        headers={"X-RapidAPI-Key": api_key, "X-RapidAPI-Host": api_host},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    # TODO: map your provider's response to (name, direct_audio_url) pairs.
    # Example shape — adjust the keys to match your endpoint:
    #   tracks = [(item["title"], item["play_url"]) for item in data["sounds"]]
    tracks = [
        (t.get("title") or t.get("id") or f"track_{i}", t.get("play_url") or t.get("url"))
        for i, t in enumerate(data.get("sounds", data.get("data", [])))
    ][:MAX_TRACKS]

    downloaded: list[Path] = []
    for name, url in tracks:
        if not url:
            continue
        dest = out_dir / f"{_slug(name)}.mp3"
        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(dest, "wb") as fh:
                for chunk in r.iter_content(8192):
                    fh.write(chunk)
        downloaded.append(dest)
    return downloaded


def upload_tracks(s3, paths: list[Path]) -> int:
    count = 0
    for p in paths:
        key = f"{MUSIC_PREFIX}{_slug(p.stem)}{p.suffix.lower()}"
        s3.upload_file(
            str(p), R2_BUCKET, key,
            ExtraArgs={"ContentType": "audio/mpeg"},
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
