import { qs, qsr, qsn } from '../utils/query';
/**
 * analytics.ts — Usage analytics for Cuba Libre
 * Tracks user events, saves interests, and provides public province-level stats
 * and trending searches/categories.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── POST /analytics/event ────────────────────────────────────────────────────

const EventSchema = z.object({
  eventtype: z.string(),
  path:      z.string().optional(),
  target:    z.string().optional(),
  value:     z.string().optional(),
  metadata:  z.any().optional(),
  province:  z.string().optional(),
  device:    z.string().optional(),
  sessionid: z.string().optional(),
});

router.post('/event', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = EventSchema.parse(req.body);
    await prisma.userEvent.create({
      data: { ...body, userid: req.user?.id },
    });
    res.json({ tracked: true });
  } catch (err: any) {
    // Analytics should never crash the client
    res.json({ tracked: false });
  }
});

// ─── POST /analytics/interests ────────────────────────────────────────────────

const InterestsSchema = z.object({
  sessionid:  z.string().optional(),
  province:   z.string().optional(),
  city:       z.string().optional(),
  categories: z.array(z.string()).default([]),
  keywords:   z.array(z.string()).default([]),
  usetype:    z.string().optional(),
});

router.post('/interests', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = InterestsSchema.parse(req.body);

    if (req.user?.id) {
      // Upsert by userId
      await prisma.userInterest.upsert({
        where:  { id: req.user.id },
        update: { ...body, userid: req.user.id, surveydone: true },
        create: { ...body, userid: req.user.id, surveydone: true },
      });
    } else {
      await prisma.userInterest.create({ data: body });
    }

    res.json({ saved: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /analytics/province-stats ───────────────────────────────────────────

router.get('/province-stats', async (_req: Request, res: Response) => {
  try {
    const [listingsByProvince, eventsByProvince] = await Promise.all([
      prisma.listing.groupBy({
        by:      ['province'],
        where:   { active: true },
        _count:  { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.event.groupBy({
        by:      ['province'],
        where:   { status: { in: ['APPROVED', 'FEATURED'] } },
        _count:  { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
    ]);

    const stats: Record<string, { listings: number; events: number }> = {};
    for (const row of listingsByProvince) {
      if (!row.province) continue;
      stats[row.province] = { listings: row._count.id, events: 0 };
    }
    for (const row of eventsByProvince) {
      if (!row.province) continue;
      if (!stats[row.province]) stats[row.province] = { listings: 0, events: 0 };
      stats[row.province].events = row._count.id;
    }

    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /analytics/trending ─────────────────────────────────────────────────

router.get('/trending', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [searchEvents, categoryEvents] = await Promise.all([
      prisma.userEvent.groupBy({
        by:      ['value'],
        where:   { eventtype: 'search', createdat: { gte: since }, value: { not: null } },
        _count:  { value: true },
        orderBy: { _count: { value: 'desc' } },
        take:    10,
      }),
      prisma.userEvent.groupBy({
        by:      ['target'],
        where:   { eventtype: 'category_click', createdat: { gte: since }, target: { not: null } },
        _count:  { target: true },
        orderBy: { _count: { target: 'desc' } },
        take:    10,
      }),
    ]);

    res.json({
      searches:   searchEvents.map(e  => ({ term:     e.value,  count: e._count.value  })),
      categories: categoryEvents.map(e => ({ category: e.target, count: e._count.target })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
