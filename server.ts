import dotenv from 'dotenv';
import express from 'express';
import path from 'path';

// Load environment variables. AI Studio injects these at runtime; locally we
// read .env.local (falling back to .env) so R2/OpenAI/Zernio keys are available.
dotenv.config({ path: ['.env.local', '.env'] });
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import { pipeline as streamPipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import Database from 'better-sqlite3';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { createServer as createViteServer } from 'vite';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// --- 1. Database Setup (SQLite WAL mode) ---
const DB_PATH = path.join(process.cwd(), 'orchestrator.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    asset_id TEXT NOT NULL,
    caption TEXT,
    result_url TEXT,
    zernio_post_id TEXT,
    published_urls TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Idempotent migrations: add columns pre-existing tables may lack.
const jobColumns = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
const ensureColumn = (name: string, ddl: string) => {
  if (!jobColumns.some((c) => c.name === name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
};
ensureColumn('result_url', 'result_url TEXT');
ensureColumn('zernio_post_id', 'zernio_post_id TEXT'); // Zernio post _id once published
ensureColumn('published_urls', 'published_urls TEXT'); // JSON [{platform, url}] live links

// --- 2. S3 / R2 Configuration ---
const getS3Client = () => {
  if (!process.env.R2_ACCOUNT_ID) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
};

// --- 3. OpenAI Configuration ---
const getOpenAIClient = () => {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

// --- Pipeline helpers ---------------------------------------------------------

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'docktok-assets';
const ZERNIO_BASE_URL = process.env.ZERNIO_API_URL || 'https://zernio.com/api/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// R2 prefix where the trending-audio scraper drops tracks; the orchestrator
// picks one at random per job ("I don't pick the music").
const R2_MUSIC_PREFIX = process.env.R2_MUSIC_PREFIX ?? 'music/';

// Stream a single R2 object down to a local file.
async function downloadFromR2(s3: S3Client, key: string, destPath: string): Promise<void> {
  const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  if (!result.Body) throw new Error(`R2 object "${key}" returned an empty body`);
  await streamPipeline(result.Body as Readable, fs.createWriteStream(destPath));
}

// Music library. Primary source is the R2 music prefix (fed by the trending-
// audio scraper); a local MUSIC_DIR is a fallback for offline/dev use.
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(process.cwd(), 'assets', 'music');
const MUSIC_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);

// Pick a random track from the local library, or null if empty/missing.
function pickLocalMusicTrack(): string | null {
  try {
    const files = fs
      .readdirSync(MUSIC_DIR)
      .filter((f) => MUSIC_EXTS.has(path.extname(f).toLowerCase()));
    if (files.length === 0) return null;
    const choice = files[Math.floor(Math.random() * files.length)];
    return path.join(MUSIC_DIR, choice);
  } catch {
    return null; // directory doesn't exist
  }
}

// Resolve a music track to a local file path for muxing: randomly select one
// from the R2 music prefix and download it; fall back to the local library.
// Returns null when no music is available anywhere (→ video-only output).
async function resolveMusicTrack(s3: S3Client | null, jobId: string): Promise<string | null> {
  if (s3) {
    try {
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: R2_MUSIC_PREFIX }),
      );
      const tracks = (list.Contents || []).filter(
        (o) => o.Key && MUSIC_EXTS.has(path.extname(o.Key).toLowerCase()),
      );
      if (tracks.length > 0) {
        const key = tracks[Math.floor(Math.random() * tracks.length)].Key as string;
        const dest = path.join(os.tmpdir(), `${jobId}-music${path.extname(key)}`);
        await downloadFromR2(s3, key, dest);
        return dest;
      }
    } catch {
      // fall through to local library
    }
  }
  return pickLocalMusicTrack();
}

// Sub-perceptual color shift that changes the output hash (fingerprint alter).
const FINGERPRINT_FILTER = 'eq=brightness=0.01:saturation=1.01';

// Re-encode the video so its byte/perceptual fingerprint differs from the source
// (strip metadata, color shift, re-encode, faststart).
//   - musicPath: loop the track to cover the clip and mux it in as audio.
//   - vertical:  fit the video onto a 1080x1920 (9:16) canvas with a blurred
//     fill background, so landscape source still publishes as a proper Reel /
//     TikTok. Already-vertical source just fills the frame.
function transcodeAndFingerprint(
  inputPath: string,
  outputPath: string,
  musicPath?: string | null,
  vertical = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    if (musicPath) cmd.input(musicPath).inputOptions(['-stream_loop', '-1']);

    const outputOptions = [
      '-map_metadata', '-1', // strip all source metadata
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
    ];

    if (vertical) {
      // 9:16 blurred-pad canvas: a blurred, cover-cropped copy as background with
      // the full source scaled to fit on top, then the fingerprint shift.
      cmd.complexFilter(
        '[0:v]split=2[bg][fg];' +
          '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:4[bgb];' +
          '[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs];' +
          `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,${FINGERPRINT_FILTER},setsar=1[outv]`,
      );
      outputOptions.push('-map', '[outv]');
      // Audio: muxed music, else keep source audio if present (optional).
      outputOptions.push('-map', musicPath ? '1:a:0' : '0:a?', '-shortest');
    } else {
      outputOptions.push('-vf', FINGERPRINT_FILTER);
      if (musicPath) outputOptions.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
    }

    cmd
      .outputOptions(outputOptions)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// Upload the processed file back to R2 and return a presigned GET URL the
// publisher can fetch (default 1h expiry).
async function uploadAndPresign(s3: S3Client, key: string, filePath: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: 'video/mp4',
    }),
  );
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), {
    expiresIn: 3600,
  });
}

// Generate a viral caption via OpenAI chat completions.
async function generateCaption(openai: OpenAI, assetId: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You write short, punchy social captions for TikTok and Instagram Reels. ' +
          'Return one caption under 150 characters with 2-4 relevant hashtags. No quotes.',
      },
      { role: 'user', content: `Write a viral caption for a short video clip (source asset: ${assetId}).` },
    ],
    max_tokens: 80,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

type ZernioTarget = { platform: string; accountId: string };

// Decide which connected accounts to publish to. Uses explicitly configured
// account IDs if present, otherwise auto-discovers the first connected TikTok
// and Instagram account via GET /accounts (each account exposes `_id`).
async function resolveZernioPlatforms(headers: Record<string, string>): Promise<ZernioTarget[]> {
  const configured: ZernioTarget[] = [];
  if (process.env.ZERNIO_TIKTOK_ACCOUNT_ID)
    configured.push({ platform: 'tiktok', accountId: process.env.ZERNIO_TIKTOK_ACCOUNT_ID });
  if (process.env.ZERNIO_INSTAGRAM_ACCOUNT_ID)
    configured.push({ platform: 'instagram', accountId: process.env.ZERNIO_INSTAGRAM_ACCOUNT_ID });
  if (configured.length > 0) return configured;

  const res = await fetch(`${ZERNIO_BASE_URL}/accounts`, { headers });
  if (!res.ok) throw new Error(`Zernio GET /accounts failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const accounts: any[] = Array.isArray(data) ? data : data.accounts || data.data || [];

  const targets: ZernioTarget[] = [];
  for (const platform of ['tiktok', 'instagram']) {
    const acct = accounts.find((a) => a.platform === platform);
    if (acct?._id) targets.push({ platform, accountId: acct._id });
  }
  if (targets.length === 0) {
    throw new Error('Zernio: no connected TikTok/Instagram accounts found (see GET /accounts)');
  }
  return targets;
}

// Publish a processed video to TikTok + Instagram via Zernio, per docs.zernio.com:
//   1. resolve target account IDs
//   2. POST /media/presign → { uploadUrl, publicUrl }
//   3. PUT the file to uploadUrl (no auth)
//   4. POST /posts with mediaItems[].url = publicUrl and publishNow: true
// Returns the created post id. Throws on any non-2xx.
async function publishViaZernio(
  videoFilePath: string,
  caption: string,
): Promise<{ postId: string; liveUrls: { platform: string; url: string }[] }> {
  const apiKey = process.env.ZERNIO_API_KEY as string;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

  const platforms = await resolveZernioPlatforms(jsonHeaders);

  // 2) Presigned upload slot
  const presignRes = await fetch(`${ZERNIO_BASE_URL}/media/presign`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ filename: path.basename(videoFilePath), contentType: 'video/mp4' }),
  });
  if (!presignRes.ok) {
    throw new Error(`Zernio presign failed: ${presignRes.status} ${await presignRes.text()}`);
  }
  const { uploadUrl, publicUrl } = (await presignRes.json()) as {
    uploadUrl?: string;
    publicUrl?: string;
  };
  if (!uploadUrl || !publicUrl) throw new Error('Zernio presign returned no uploadUrl/publicUrl');

  // 3) Upload the bytes to the presigned URL (no auth header)
  const fileBuf = await fs.promises.readFile(videoFilePath);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: fileBuf,
  });
  if (!putRes.ok) throw new Error(`Zernio media upload failed: ${putRes.status}`);

  // 4) Create + publish the post.
  // - x-request-id makes the call idempotent (safe to retry → no double-post).
  // - tiktokSettings are required by TikTok for direct video publishing
  //   (privacy + interaction flags); Zernio merges them into TikTok targets only.
  const postRes = await fetch(`${ZERNIO_BASE_URL}/posts`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'x-request-id': randomUUID() },
    body: JSON.stringify({
      content: caption,
      mediaItems: [{ url: publicUrl, type: 'video' }],
      platforms,
      publishNow: true,
      tiktokSettings: {
        privacyLevel: process.env.ZERNIO_TIKTOK_PRIVACY || 'PUBLIC_TO_EVERYONE',
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
      },
    }),
  });
  if (!postRes.ok) {
    throw new Error(`Zernio POST /posts failed: ${postRes.status} ${await postRes.text()}`);
  }
  const postJson: any = await postRes.json();
  const post = postJson?.post ?? {};
  return { postId: post._id || '', liveUrls: extractLiveUrls(post) };
}

// Pull [{platform, url}] from a Zernio post object (only platforms with a URL).
function extractLiveUrls(post: any): { platform: string; url: string }[] {
  return (post?.platforms || [])
    .filter((p: any) => p.platformPostUrl)
    .map((p: any) => ({ platform: p.platform, url: p.platformPostUrl }));
}

// After publish, TikTok/Instagram finish asynchronously, so the live post URLs
// aren't in the create response. Poll GET /posts/{id} in the background and write
// the links to the job row as they appear (the dashboard polls and picks them up).
async function pollPublishedUrls(postId: string, jobId: string): Promise<void> {
  const headers = { Authorization: `Bearer ${process.env.ZERNIO_API_KEY as string}` };
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const res = await fetch(`${ZERNIO_BASE_URL}/posts/${postId}`, { headers });
      if (!res.ok) continue;
      const data: any = await res.json();
      const post = data.post ?? data;
      const urls = extractLiveUrls(post);
      if (urls.length) {
        db.prepare('UPDATE jobs SET published_urls = ? WHERE id = ?').run(
          JSON.stringify(urls),
          jobId,
        );
      }
      const platforms = post?.platforms || [];
      if (post?.status === 'published' || platforms.every((p: any) => ['published', 'failed'].includes(p.status))) {
        return;
      }
    } catch {
      // transient; keep polling
    }
  }
}

// --- Express App Setup ---
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// API: Get all jobs
app.get('/api/jobs', (req, res) => {
  try {
    const stmt = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50");
    const jobs = stmt.all();
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB Error' });
  }
});

// API: Trigger an orchestrator job
app.post('/api/trigger', async (req, res) => {
  const { assetId, dryRun } = req.body;
  if (!assetId) {
    return res.status(400).json({ error: 'assetId is required' });
  }
  // Vertical 9:16 (Reel/TikTok) formatting: per-request override, else env default.
  const vertical =
    req.body.vertical !== undefined
      ? Boolean(req.body.vertical)
      : process.env.FORCE_VERTICAL === 'true';

  const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    db.prepare('INSERT INTO jobs (id, asset_id, status) VALUES (?, ?, ?)')
      .run(jobId, assetId, 'processing');

    // Respond immediately, perform real flow asynchronously
    res.json({ success: true, jobId, dryRun: Boolean(dryRun), vertical });

    // Asynchronous processing (simulated scaffolding if keys missing).
    // dryRun runs the full chain but SKIPS the live Zernio publish.
    processJob(jobId, assetId, Boolean(dryRun), vertical).catch(async (error) => {
      console.error(`Job ${jobId} Failed:`, error);
      db.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('error', String(error), jobId);
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Orchestration Logic Flow.
// Each stage runs its real integration when the required env/keys are present,
// and otherwise falls back to a short mock delay so the dashboard still works
// end-to-end without any credentials configured.
async function processJob(jobId: string, assetId: string, dryRun = false, vertical = false) {
  const logStep = (status: string) => {
    db.prepare('UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, jobId);
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `${jobId}-input.mp4`);
  const outputPath = path.join(tmpDir, `${jobId}-output.mp4`);
  let musicPath: string | null = null;
  let haveLocalSource = false;
  let haveProcessedFile = false;

  try {
    const s3 = getS3Client();
    const openai = getOpenAIClient();

    // --- Step 1: Download from R2 ---
    logStep('fetching_r2');
    if (s3) {
      await downloadFromR2(s3, assetId, inputPath);
      haveLocalSource = true;
    } else {
      await wait(1000); // mock
    }

    // --- Step 2: FFmpeg (mux music + re-encode + fingerprint alter) ---
    logStep('muxing_ffmpeg');
    if (haveLocalSource) {
      musicPath = await resolveMusicTrack(s3, jobId); // random R2 track; null if none
      await transcodeAndFingerprint(inputPath, outputPath, musicPath, vertical);
      haveProcessedFile = true;
    } else {
      await wait(1500); // mock
    }

    // --- Step 3: OpenAI (generate caption) ---
    logStep('generating_captions');
    let finalCaption = 'Generated dynamic caption test \ud83d\ude80 #docktok #viral';
    if (openai) {
      finalCaption = (await generateCaption(openai, assetId)) || finalCaption;
    } else {
      await wait(1000); // mock
    }
    db.prepare('UPDATE jobs SET caption = ? WHERE id = ?').run(finalCaption, jobId);

    // --- Step 4: Archive processed video to R2 + publish via Zernio ---
    logStep('publishing_zernio');
    // Archive the processed video to R2 (storage of record) and surface a
    // presigned preview URL on the dashboard.
    if (s3 && haveProcessedFile) {
      const processedKey = `processed/${jobId}.mp4`;
      const previewUrl = await uploadAndPresign(s3, processedKey, outputPath);
      db.prepare('UPDATE jobs SET result_url = ? WHERE id = ?').run(previewUrl, jobId);
    }
    // Publish the processed file to TikTok + Instagram (unless this is a dry run).
    if (dryRun) {
      logStep('dry_run_complete');
      return;
    }
    if (process.env.ZERNIO_API_KEY && haveProcessedFile) {
      const { postId, liveUrls } = await publishViaZernio(outputPath, finalCaption);
      if (postId) db.prepare('UPDATE jobs SET zernio_post_id = ? WHERE id = ?').run(postId, jobId);
      if (liveUrls.length) {
        db.prepare('UPDATE jobs SET published_urls = ? WHERE id = ?').run(JSON.stringify(liveUrls), jobId);
      } else if (postId) {
        // Live URLs land asynchronously; fill them in via background poll.
        void pollPublishedUrls(postId, jobId);
      }
    } else {
      await wait(1000); // mock (no key, or nothing to publish)
    }

    logStep('completed');
  } finally {
    // Best-effort temp cleanup.
    for (const p of [inputPath, outputPath, musicPath]) {
      if (p) fs.promises.unlink(p).catch(() => {});
    }
  }
}


// --- Vite Middleware Setup ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
