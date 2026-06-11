import { qs, qsr, qsn } from '../utils/query';
/**
 * upload.ts — File upload endpoint for Cuba Libre via Vercel Blob
 * Max file size: 10MB. Returns the public URL of the uploaded blob.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// ─── POST /upload ─────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { put } = await import('@vercel/blob');

    const contentType   = req.headers['content-type'] ?? 'application/octet-stream';
    const filename      = (req.headers['x-filename'] as string) ?? `upload-${Date.now()}`;
    const contentLength = parseInt(req.headers['content-length'] ?? '0');

    if (contentLength > MAX_SIZE_BYTES) {
      return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
    }

    const blob = await put(
      `cuba-libre/${req.user!.id}/${filename}`,
      req,
      {
        access:      'public',
        contentType,
        token:       process.env.BLOB_READ_WRITE_TOKEN,
      },
    );

    res.json({ url: blob.url, downloadUrl: blob.downloadUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /upload/url — Upload from a URL ────────────────────────────────────

router.post('/url', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: 'url required' });

    const { put } = await import('@vercel/blob');

    const resp = await fetch(url);
    if (!resp.ok) return res.status(400).json({ error: 'Could not fetch source URL' });

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.byteLength > MAX_SIZE_BYTES) {
      return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
    }

    const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
    const ext         = contentType.split('/')[1]?.split(';')[0] ?? 'bin';
    const filename    = `cuba-libre/${req.user!.id}/remote-${Date.now()}.${ext}`;

    const blob = await put(filename, buffer, {
      access:      'public',
      contentType,
      token:       process.env.BLOB_READ_WRITE_TOKEN,
    });

    res.json({ url: blob.url, downloadUrl: blob.downloadUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
