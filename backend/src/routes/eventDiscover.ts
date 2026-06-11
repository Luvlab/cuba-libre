import { qs, qsr, qsn } from '../utils/query';
/**
 * eventDiscover.ts — Event discovery feed for Cuba Libre
 * Province-grouped discovery, featured events, and tracking.
 */

import { Router, Request, Response } from 'express';
import prisma from '../db';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';

const router = Router();

// ─── GET /discover ────────────────────────────────────────────────────────────

router.get('/discover', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, limit = '20' } = req.query as Record<string, string>;
    const take = Math.min(parseInt(limit) || 20, 100);

    const where: any = { status: { in: ['APPROVED', 'FEATURED'] } };
    if (province) where.province = province;
    if (category) where.category = category;

    const events = await prisma.event.findMany({
      where,
      take,
      orderBy: { createdat: 'desc' },
    });

    // Group by province
    const byProvince: Record<string, any[]> = {};
    for (const p of CUBA_PROVINCES) byProvince[p] = [];
    for (const e of events) {
      const key = e.province ?? 'Nacional';
      if (!byProvince[key]) byProvince[key] = [];
      byProvince[key].push(e);
    }

    // Quick count per province (all time, approved/featured)
    const provinceCounts = await prisma.event.groupBy({
      by:     ['province'],
      where:  { status: { in: ['APPROVED', 'FEATURED'] } },
      _count: { id: true },
    });

    const counts: Record<string, number> = {};
    for (const row of provinceCounts) {
      counts[row.province ?? 'Nacional'] = row._count.id;
    }

    res.json({ byProvince, counts, total: events.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /featured ────────────────────────────────────────────────────────────

router.get('/featured', async (_req: Request, res: Response) => {
  try {
    const events = await prisma.event.findMany({
      where:   { status: 'FEATURED' },
      take:    6,
      orderBy: { views: 'desc' },
    });
    res.json(events);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /discover/track ─────────────────────────────────────────────────────

router.post('/discover/track', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category } = req.body as { province?: string; category?: string };

    await prisma.userEvent.create({
      data: {
        userid:    req.user?.id,
        eventtype: 'event_discover',
        metadata:  { province, category },
      },
    });

    res.json({ tracked: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
