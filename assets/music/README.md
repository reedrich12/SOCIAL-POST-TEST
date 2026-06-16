# Music library (local fallback)

The **primary** music source is the R2 music prefix (`R2_MUSIC_PREFIX`, default
`music/`), which a trending-audio scraper keeps stocked; the orchestrator picks
a random track from there per job and muxes it onto the (silent) source clip,
looped to cover the full video length.

This folder is the **offline/dev fallback**, used only when the R2 prefix is
empty. Drop tracks here (`.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.flac`); set
`MUSIC_DIR` to override the location. If neither source has audio, the FFmpeg
stage falls back to a video-only re-encode.

Use tracks you have the rights to publish.
