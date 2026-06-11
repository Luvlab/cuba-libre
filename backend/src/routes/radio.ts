import { qs, qsr, qsn } from '../utils/query';
/**
 * radio.ts — Cuban radio & music routes for Cuba Libre
 * Streams from RadioBrowser (Cuban stations), Jamendo (CC Latin/Cuban music),
 * Internet Archive (royalty-free Cuban music), and community-submitted tracks.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Cuban music genres ───────────────────────────────────────────────────────

const GENRES = [
  { id: 'salsa',       label: 'Salsa',        emoji: '💃' },
  { id: 'son',         label: 'Son Cubano',   emoji: '🎸' },
  { id: 'timba',       label: 'Timba',        emoji: '🥁' },
  { id: 'bolero',      label: 'Bolero',       emoji: '🌹' },
  { id: 'reggaeton',   label: 'Reggaeton',    emoji: '🎧' },
  { id: 'guaguanco',   label: 'Guaguancó',    emoji: '🎺' },
  { id: 'rumba',       label: 'Rumba',        emoji: '🪘' },
  { id: 'nueva_trova', label: 'Nueva Trova',  emoji: '🎵' },
  { id: 'jazz',        label: 'Cuban Jazz',   emoji: '🎷' },
  { id: 'trova',       label: 'Trova',        emoji: '🎤' },
];

// ─── GET /radio/genres ────────────────────────────────────────────────────────

router.get('/genres', (_req, res) => {
  res.json(GENRES);
});

// ─── GET /radio/stations — RadioBrowser: Cuban stations ──────────────────────

router.get('/stations', async (req, res) => {
  try {
    const { genre, limit = '30' } = req.query as Record<string, string>;
    const genreQuery = genre ?? 'salsa,timba,son,cuba';

    const params = new URLSearchParams({
      countrycode: 'CU',
      tag:         genreQuery,
      limit:       limit,
      order:       'votes',
      reverse:     'true',
      hidebroken:  'true',
    });

    const resp = await fetch(`https://de1.api.radio-browser.info/json/stations/search?${params}`, {
      headers: { 'User-Agent': 'CubaLibre/1.0 (https://cuba.libre)' },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Radio browser unavailable' });
    const stations = await resp.json();
    res.json(stations);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /radio/stations/all-cuba — All Cuban stations without genre filter ──

router.get('/stations/all-cuba', async (req, res) => {
  try {
    const { limit = '50' } = req.query as Record<string, string>;
    const params = new URLSearchParams({
      countrycode: 'CU',
      limit,
      order:       'clickcount',
      reverse:     'true',
      hidebroken:  'true',
    });

    const resp = await fetch(`https://de1.api.radio-browser.info/json/stations/search?${params}`, {
      headers: { 'User-Agent': 'CubaLibre/1.0' },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Radio browser unavailable' });
    res.json(await resp.json());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /radio/jamendo — Jamendo Cuban/Latin CC tracks ──────────────────────

router.get('/jamendo', async (req, res) => {
  try {
    const { genre = 'salsa', limit = '20' } = req.query as Record<string, string>;
    const clientId = process.env.JAMENDO_CLIENT_ID ?? '';

    if (!clientId) return res.status(400).json({ error: 'Jamendo not configured' });

    const params = new URLSearchParams({
      client_id: clientId,
      format:    'json',
      limit,
      tags:      genre,
      audioformat: 'mp32',
    });

    const resp = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params}`);
    if (!resp.ok) return res.status(502).json({ error: 'Jamendo unavailable' });

    const data = await resp.json() as any;
    res.json(data.results ?? []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /radio/archive — Internet Archive: royalty-free Cuban music ─────────

router.get('/archive', async (req, res) => {
  try {
    const { query = 'Cuban music', rows = '20', page = '1' } = req.query as Record<string, string>;
    const searchQuery = `${query} AND mediatype:audio AND subject:(cuba OR cuban OR cubano OR havana)`;

    const params = new URLSearchParams({
      q:        searchQuery,
      fl:       'identifier,title,creator,description,avg_rating,downloads,year',
      sort:     'downloads desc',
      rows,
      page,
      output:   'json',
    });

    const resp = await fetch(`https://archive.org/advancedsearch.php?${params}`);
    if (!resp.ok) return res.status(502).json({ error: 'Internet Archive unavailable' });

    const data = await resp.json() as any;
    const items = (data.response?.docs ?? []).map((doc: any) => ({
      ...doc,
      playUrl: `https://archive.org/embed/${doc.identifier}`,
      downloadUrl: `https://archive.org/download/${doc.identifier}`,
    }));

    res.json({ items, total: data.response?.numFound ?? 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /radio/community — Community-submitted tracks ───────────────────────

router.get('/community', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { genre, province, page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = { approved: true };
    if (genre)    where.genre = genre;
    if (province) where.province = province;

    const [tracks, total] = await Promise.all([
      prisma.radioTrack.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { plays: 'desc' },
      }),
      prisma.radioTrack.count({ where }),
    ]);

    res.json({ tracks, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /radio/community — Submit a community track ────────────────────────

const SubmitTrackSchema = z.object({
  title:    z.string().min(2),
  artist:   z.string().optional(),
  url:      z.string().url(),
  genre:    z.string().optional(),
  province: z.string().optional(),
});

router.post('/community', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = SubmitTrackSchema.parse(req.body);
    const track = await prisma.radioTrack.create({
      data: { ...body, submittedby: req.user!.id, approved: false },
    });
    res.status(201).json({ track, message: 'Track submitted for review' });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /radio/community/:id/play — Increment play count ───────────────────

router.post('/community/:id/play', async (req, res) => {
  try {
    await prisma.radioTrack.update({
      where: { id: qsr(req.params.id) },
      data:  { plays: { increment: 1 } },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /radio/community/:id/approve (admin) ───────────────────────────────

router.patch('/community/:id/approve', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
    const track = await prisma.radioTrack.update({
      where: { id: qsr(req.params.id) },
      data:  { approved: true },
    });
    res.json(track);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
