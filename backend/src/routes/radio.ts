/**
 * radio.ts — Cuban radio & music routes for Cuba Libre
 *
 * Layers (in priority order):
 *  1. Hardcoded known Cuban stations — always available as fallback
 *  2. RadioBrowser API — crowdsourced CU stations, filtered by genre
 *  3. Jamendo Creative Commons — Latin / Cuban tags
 *  4. Internet Archive — royalty-free Cuban music (oldest to newest)
 *  5. Community-submitted tracks — curated by the platform
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { qs, qsr, qsn } from '../utils/query';

const router = Router();

// ─── Cuban music genres ───────────────────────────────────────────────────────

const GENRES = [
  { id: 'salsa',        label: 'Salsa',          emoji: '💃', jamendoTag: 'salsa' },
  { id: 'son',          label: 'Son Cubano',      emoji: '🎸', jamendoTag: 'son cubano' },
  { id: 'timba',        label: 'Timba',           emoji: '🥁', jamendoTag: 'timba' },
  { id: 'bolero',       label: 'Bolero',          emoji: '🌹', jamendoTag: 'bolero' },
  { id: 'reggaeton',    label: 'Reggaeton',       emoji: '🎧', jamendoTag: 'reggaeton' },
  { id: 'guaguanco',    label: 'Guaguancó',       emoji: '🎺', jamendoTag: 'guaguanco' },
  { id: 'rumba',        label: 'Rumba',           emoji: '🪘', jamendoTag: 'rumba' },
  { id: 'nueva_trova',  label: 'Nueva Trova',     emoji: '🎵', jamendoTag: 'nueva trova' },
  { id: 'jazz',         label: 'Cuban Jazz',      emoji: '🎷', jamendoTag: 'cuban jazz' },
  { id: 'trova',        label: 'Trova',           emoji: '🎤', jamendoTag: 'trova' },
  { id: 'danzon',       label: 'Danzón',          emoji: '🎻', jamendoTag: 'danzon' },
  { id: 'mambo',        label: 'Mambo',           emoji: '🎹', jamendoTag: 'mambo' },
  { id: 'cha_cha_cha',  label: 'Cha-Cha-Chá',    emoji: '👟', jamendoTag: 'cha cha cha' },
  { id: 'latin_jazz',   label: 'Latin Jazz',      emoji: '🎺', jamendoTag: 'latin jazz' },
  { id: 'afrocubano',   label: 'Afrocubano',      emoji: '🥁', jamendoTag: 'afro-cuban' },
];

// ─── Hardcoded known Cuban radio stations (always available) ──────────────────

const CUBAN_STATIONS_HARDCODED = [
  { name: 'Radio Rebelde',       stationuuid: 'hardcoded-rebelde',  url_resolved: 'https://radiorebelde.cu/radio/rebelde-stream.mp3',        favicon: '', country: 'Cuba', language: 'Spanish', tags: 'news,culture,cuba', votes: 9999, codec: 'MP3', bitrate: 128 },
  { name: 'Radio Havana Cuba',   stationuuid: 'hardcoded-rhc',      url_resolved: 'https://radiohc.cu/radio/radiohc-stream.mp3',             favicon: '', country: 'Cuba', language: 'Spanish', tags: 'news,cuba,international', votes: 9998, codec: 'MP3', bitrate: 128 },
  { name: 'CMHW Radio Victoria', stationuuid: 'hardcoded-cmhw',     url_resolved: 'https://www.cmhwradio.cu/radio/cmhw-stream.mp3',          favicon: '', country: 'Cuba', language: 'Spanish', tags: 'music,villa clara,cuba', votes: 9997, codec: 'MP3', bitrate: 128 },
  { name: 'Radio Progreso',      stationuuid: 'hardcoded-progreso',  url_resolved: 'https://www.radioprogreso.cu/radio/progreso-stream.mp3',  favicon: '', country: 'Cuba', language: 'Spanish', tags: 'music,salsa,cuba', votes: 9996, codec: 'MP3', bitrate: 128 },
  { name: 'Radio Taíno',         stationuuid: 'hardcoded-taino',     url_resolved: 'https://www.radioreloj.cu/radio/taino-stream.mp3',        favicon: '', country: 'Cuba', language: 'Spanish', tags: 'tourism,cuba,music', votes: 9995, codec: 'MP3', bitrate: 128 },
  { name: 'Radio Reloj',         stationuuid: 'hardcoded-reloj',     url_resolved: 'https://www.radioreloj.cu/radio/reloj-stream.mp3',        favicon: '', country: 'Cuba', language: 'Spanish', tags: 'news,cuba', votes: 9994, codec: 'MP3', bitrate: 128 },
  { name: 'Radio COCO',          stationuuid: 'hardcoded-coco',      url_resolved: 'https://www.radiococo.icrt.cu/radio/coco-stream.mp3',     favicon: '', country: 'Cuba', language: 'Spanish', tags: 'pop,youth,cuba', votes: 9993, codec: 'MP3', bitrate: 128 },
  { name: 'Radio Musical Nacional', stationuuid: 'hardcoded-musical', url_resolved: 'https://www.rna.cu/radio/musical-stream.mp3',           favicon: '', country: 'Cuba', language: 'Spanish', tags: 'classical,music,cuba', votes: 9992, codec: 'MP3', bitrate: 128 },
  { name: 'Radio Enciclopedia',  stationuuid: 'hardcoded-enciclo',   url_resolved: 'https://www.rna.cu/radio/enciclopedia-stream.mp3',        favicon: '', country: 'Cuba', language: 'Spanish', tags: 'instrumental,cuba', votes: 9991, codec: 'MP3', bitrate: 128 },
  { name: 'Radio CMKX Santiago', stationuuid: 'hardcoded-cmkx',      url_resolved: 'https://www.radiorebelde.cu/radio/santiago-stream.mp3',   favicon: '', country: 'Cuba', language: 'Spanish', tags: 'santiago,cuba', votes: 9990, codec: 'MP3', bitrate: 128 },
];

// ─── GET /radio/genres ────────────────────────────────────────────────────────

router.get('/genres', (_req, res) => {
  res.json(GENRES);
});

// ─── GET /radio/stations — Cuban stations (hardcoded + RadioBrowser) ─────────

router.get('/stations', async (req, res) => {
  try {
    const genre  = qs(req.query.genre) ?? 'salsa,timba,son,cuba';
    const limit  = qsn(req.query.limit, 30);

    // Always try RadioBrowser first
    let liveStations: unknown[] = [];
    try {
      const params = new URLSearchParams({
        countrycode: 'CU',
        tag:         genre,
        limit:       String(Math.max(10, limit - CUBAN_STATIONS_HARDCODED.length)),
        order:       'votes',
        reverse:     'true',
        hidebroken:  'true',
      });
      const resp = await fetch(`https://de1.api.radio-browser.info/json/stations/search?${params}`, {
        headers: { 'User-Agent': 'CubaLibre/1.0 (+https://cuba.red)' },
        signal:  AbortSignal.timeout(6000),
      });
      if (resp.ok) liveStations = await resp.json() as unknown[];
    } catch {
      // RadioBrowser down — use hardcoded only
    }

    // Merge: hardcoded first, then live (deduped by name)
    const liveNames = new Set((liveStations as any[]).map((s: any) => s.name?.toLowerCase()));
    const merged = [
      ...CUBAN_STATIONS_HARDCODED.filter(s => !liveNames.has(s.name.toLowerCase())),
      ...liveStations,
    ].slice(0, limit);

    res.json(merged);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /radio/stations/all-cuba — All Cuban stations (hardcoded fallback) ──

router.get('/stations/all-cuba', async (req, res) => {
  try {
    const limit  = qsn(req.query.limit, 50);
    let liveStations: unknown[] = [];

    try {
      const params = new URLSearchParams({
        countrycode: 'CU',
        limit:       String(limit),
        order:       'clickcount',
        reverse:     'true',
        hidebroken:  'true',
      });
      const resp = await fetch(`https://de1.api.radio-browser.info/json/stations/search?${params}`, {
        headers: { 'User-Agent': 'CubaLibre/1.0' },
        signal:  AbortSignal.timeout(6000),
      });
      if (resp.ok) liveStations = await resp.json() as unknown[];
    } catch {
      // Fall through to hardcoded
    }

    if (liveStations.length > 0) return res.json(liveStations);
    res.json(CUBAN_STATIONS_HARDCODED);   // always-available fallback
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
