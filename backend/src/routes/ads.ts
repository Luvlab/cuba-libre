import { qs, qsr, qsn } from '../utils/query';
/**
 * ads.ts — Advertising system for Cuba Libre
 * Scored ad serving by province/category/tier.
 * Ad packages: Starter $5/wk, Boost $15/30d, Pro $40/30d, Featured $99/30d.
 * All revenue helps keep Cuba Libre free.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Ad packages ──────────────────────────────────────────────────────────────

const AD_PACKAGES = {
  starter:  { label: 'Starter',  usd: 5,  days: 7,  tier: 'BANNER',    impressionBoost: 1 },
  boost:    { label: 'Boost',    usd: 15, days: 30, tier: 'SPONSORED',  impressionBoost: 3 },
  pro:      { label: 'Pro',      usd: 40, days: 30, tier: 'FEATURED',   impressionBoost: 8 },
  featured: { label: 'Featured', usd: 99, days: 30, tier: 'PREMIUM',    impressionBoost: 20 },
};

// ─── Scoring algorithm ────────────────────────────────────────────────────────

function scoreAd(
  ad: any,
  context: { province?: string; category?: string; sessionId?: string },
): number {
  let score = 1;

  // Tier boost
  const tierBoosts: Record<string, number> = { BANNER: 1, SPONSORED: 3, FEATURED: 8, PREMIUM: 20 };
  score *= tierBoosts[ad.tier] ?? 1;

  // Province match
  if (context.province && (ad.province === context.province || ad.provinces?.includes(context.province))) {
    score *= 3;
  }

  // Category match
  if (context.category && ad.category === context.category) {
    score *= 2;
  }

  // CTR performance bonus
  if (ad.ctr > 0.05) score *= 1.5;
  if (ad.ctr > 0.10) score *= 2;

  // Budget remaining bonus (encourage spend)
  const budgetRemaining = ad.budget - ad.spent;
  if (budgetRemaining > 0) score *= Math.min(1 + budgetRemaining / 100, 2);

  return score;
}

// ─── GET /ads/serve ───────────────────────────────────────────────────────────

router.get('/serve', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, sessionId } = req.query as Record<string, string>;
    const now = new Date();

    const ads = await prisma.ad.findMany({
      where: {
        active:   true,
        approved: true,
        startdate: { lte: now },
        enddate:   { gte: now },
      },
    });

    if (!ads.length) return res.json(null);

    // Score and pick top
    const scored = ads.map(ad => ({ ad, score: scoreAd(ad, { province, category, sessionId }) }));
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0].ad;

    // Record impression async
    prisma.$transaction([
      prisma.adImpression.create({
        data: {
          adid:      winner.id,
          userid:    req.user?.id,
          sessionid: sessionId,
        },
      }),
      prisma.ad.update({
        where: { id: winner.id },
        data:  { impressions: { increment: 1 } },
      }),
    ]).catch(() => {});

    res.json(winner);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /ads/packages ────────────────────────────────────────────────────────

router.get('/packages', (_req: Request, res: Response) => {
  res.json(AD_PACKAGES);
});

// ─── POST /ads ────────────────────────────────────────────────────────────────

const AdSchema = z.object({
  title:          z.string().min(3),
  description:    z.string().optional(),
  imageurl:       z.string().url().optional(),
  targeturl:      z.string().url().optional(),
  advertiser:     z.string().optional(),
  listingid:      z.string().uuid().optional(),
  tier:           z.enum(['BANNER', 'SPONSORED', 'FEATURED', 'PREMIUM']).default('BANNER'),
  province:       z.string().optional(),
  provinces:      z.array(z.string()).default([]),
  category:       z.string().optional(),
  targetkeywords: z.array(z.string()).default([]),
  budget:         z.number().default(0),
  startdate:      z.string().datetime(),
  enddate:        z.string().datetime(),
  package:        z.enum(['starter', 'boost', 'pro', 'featured']).optional(),
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = AdSchema.parse(req.body);

    const ad = await prisma.ad.create({
      data: {
        ...body,
        userid:    req.user!.id,
        startdate: new Date(body.startdate),
        enddate:   new Date(body.enddate),
        approved:  false,
      },
    });

    res.status(201).json(ad);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /ads/my ──────────────────────────────────────────────────────────────

router.get('/my', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ads = await prisma.ad.findMany({
      where:   { userid: req.user!.id },
      orderBy: { createdat: 'desc' },
    });
    res.json(ads);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /ads/:id ───────────────────────────────────────────────────────────

router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ad = await prisma.ad.findUnique({ where: { id: qsr(req.params.id) } });
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const isOwner = ad.userid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const body = AdSchema.partial().parse(req.body);
    const updated = await prisma.ad.update({
      where: { id: qsr(req.params.id) },
      data:  {
        ...body,
        startdate: body.startdate ? new Date(body.startdate) : undefined,
        enddate:   body.enddate   ? new Date(body.enddate)   : undefined,
      },
    });

    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /ads/:id/click — track click ───────────────────────────────────────

router.post('/:id/click', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ad = await prisma.ad.findUnique({ where: { id: qsr(req.params.id) } });
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const clicks     = ad.clicks + 1;
    const ctr        = ad.impressions > 0 ? clicks / ad.impressions : 0;
    const newSpent   = ad.spent + (ad.budget / Math.max(ad.impressions, 1));

    await prisma.ad.update({
      where: { id: qsr(req.params.id) },
      data:  { clicks, ctr, spent: newSpent },
    });

    res.json({ redirectUrl: ad.targeturl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
