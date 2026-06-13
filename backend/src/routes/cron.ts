/**
 * cron.ts — scheduled job endpoints for Cuba Libre
 *
 * All routes are protected by Authorization: Bearer <CRON_SECRET>.
 * Vercel calls them automatically via the schedule in vercel.json.
 * GitHub Actions calls them via curl (see .github/workflows/scrape.yml).
 *
 * Vercel Pro required for scrape-osm (runs ~90-180 s).
 * On Hobby tier, use GitHub Actions instead — it runs npm run scrape:osm
 * directly against the database without going through this HTTP endpoint.
 */

import { Router, Request, Response } from 'express';
import { runOsmScrape }              from '../scraper/osmScrape';

const router = Router();

// ─── Auth guard ───────────────────────────────────────────────────────────────

function guardCron(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured — reject to avoid accidental public exposure
    res.status(503).json({ error: 'CRON_SECRET not configured' });
    return false;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─── POST /api/cron/scrape-osm ────────────────────────────────────────────────
// Triggered 4× per day by vercel.json (every 6 hours at :00).
// On Vercel Pro the function timeout is set to 300 s (see vercel.json).
// On Hobby, this endpoint will time out — use GitHub Actions instead.

router.all('/scrape-osm', async (req: Request, res: Response) => {
  if (!guardCron(req, res)) return;

  const start = Date.now();
  const logs: string[] = [];
  const log = (msg: string) => { logs.push(msg); console.log(msg); };

  // Respond 202 immediately; Vercel will keep the function alive while the
  // async work runs (Pro: up to 300 s). Hobby tier will close the connection
  // at 10 s — the scrape continues until DB disconnects on the free plan.
  res.status(202).json({ message: 'OSM scrape started', ts: new Date().toISOString() });

  try {
    const result = await runOsmScrape({ log });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ cron/scrape-osm complete in ${elapsed}s — ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.error('❌ cron/scrape-osm failed:', err.message);
  }
});

// ─── GET /api/cron/health ────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
  if (!guardCron(req, res)) return;
  res.json({ ok: true, ts: new Date().toISOString() });
});

export default router;
