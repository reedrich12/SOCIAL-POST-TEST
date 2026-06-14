import express from 'express';
import path from 'path';
import cors from 'cors';
import fs from 'fs';
import Database from 'better-sqlite3';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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
    asset_id TEXT NOT EXISTS,
    caption TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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

// --- Express App Setup ---
const app = express();
const PORT = 3000;

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
  const { assetId } = req.body;
  if (!assetId) {
    return res.status(400).json({ error: 'assetId is required' });
  }

  const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    db.prepare('INSERT INTO jobs (id, asset_id, status) VALUES (?, ?, ?)')
      .run(jobId, assetId, 'processing');
      
    // Respond immediately, perform real flow asynchronously
    res.json({ success: true, jobId });
    
    // Asynchronous processing (simulated scaffolding if keys missing)
    processJob(jobId, assetId).catch(async (error) => {
      console.error(`Job ${jobId} Failed:`, error);
      db.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('error', String(error), jobId);
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Orchestration Logic Flow
async function processJob(jobId: string, assetId: string) {
  // Update status internally
  const logStep = (status: string) => {
    db.prepare('UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, jobId);
  };
  
  // Fake delay helper for mock
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // --- Step 1: Download from R2 ---
  logStep('fetching_r2');
  const s3 = getS3Client();
  if (s3) {
    // Implement actual download logic here when fully configured
    // const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: assetId });
    // const result = await s3.send(command);
  }
  await wait(1000);

  // --- Step 2: FFmpeg (Mux Audio & Fingerprint Alter) ---
  logStep('muxing_ffmpeg');
  // Simulated FFmpeg logic. In actuality:
  // ffmpeg('/tmp/input.mp4').addInput('/tmp/audio.mp3').outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0']).save('/tmp/output.mp4')
  await wait(1500);

  // --- Step 3: OpenAI (Generate Captions) ---
  logStep('generating_captions');
  let finalCaption = "Generated dynamic caption test \ud83d\ude80 #docktok #viral";
  const openai = getOpenAIClient();
  if (openai) {
    // const response = await openai.chat.completions.create({
    //   model: 'gpt-4o',
    //   messages: [{ role: 'user', content: `Generate a viral caption for an asset tagged ${assetId}` }]
    // });
    // finalCaption = response.choices[0].message.content || finalCaption;
  }
  // Store caption in DB
  db.prepare('UPDATE jobs SET caption = ? WHERE id = ?').run(finalCaption, jobId);
  await wait(1000);

  // --- Step 4: Publish via Zernio ---
  logStep('publishing_zernio');
  if (process.env.ZERNIO_API_KEY) {
    /*
    await fetch('https://api.zernio.com/v1/publish', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.ZERNIO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: assetId, platforms: ['tiktok', 'instagram'], caption: finalCaption })
    });
    */
  }
  await wait(1000);

  // Mark Complete
  logStep('completed');
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
