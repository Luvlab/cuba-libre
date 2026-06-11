import { qs, qsr, qsn } from '../utils/query';
/**
 * salesreps.ts — Sales rep programme for Cuba Libre
 * Reps sell ad packages to local businesses and earn commissions in Libre.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── GET /me — current rep profile ───────────────────────────────────────────

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rep = await prisma.salesRep.findUnique({
      where:   { userid: req.user!.id },
      include: {
        commissions: { orderBy: { createdat: 'desc' }, take: 20 },
        feedback:    { orderBy: { createdat: 'desc' }, take: 20 },
      },
    });
    if (!rep) return res.status(404).json({ error: 'Not a sales rep' });

    res.json(rep);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /apply — apply to become a sales rep ───────────────────────────────

const ApplySchema = z.object({
  province:  z.string().min(2),
  territory: z.string().optional(),
});

router.post('/apply', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = ApplySchema.parse(req.body);

    const existing = await prisma.salesRep.findUnique({ where: { userid: req.user!.id } });
    if (existing) return res.status(409).json({ error: 'Already applied or active as a sales rep' });

    const [rep] = await prisma.$transaction([
      prisma.salesRep.create({
        data: {
          userid:    req.user!.id,
          province:  body.province,
          territory: body.territory,
          status:    'PENDING',
        },
      }),
      prisma.user.update({
        where: { id: req.user!.id },
        data:  { role: 'SALES_REP' },
      }),
    ]);

    res.status(201).json(rep);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /dashboard — rep stats ───────────────────────────────────────────────

router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rep = await prisma.salesRep.findUnique({ where: { userid: req.user!.id } });
    if (!rep) return res.status(404).json({ error: 'Not a sales rep' });

    const [activeAds, pendingCommissions, recentCommissions, feedbackAgg] = await Promise.all([
      prisma.ad.count({ where: { salesrepid: rep.id, active: true } }),
      prisma.commission.aggregate({
        where:  { salesrepid: rep.id, status: 'PENDING' },
        _sum:   { amount: true },
        _count: { id: true },
      }),
      prisma.commission.findMany({
        where:   { salesrepid: rep.id },
        take:    10,
        orderBy: { createdat: 'desc' },
      }),
      prisma.salesFeedback.aggregate({
        where: { salesrepid: rep.id },
        _avg:  { rating: true },
        _count: { id: true },
      }),
    ]);

    res.json({
      rep,
      totalearned:        rep.totalearned,
      activeAds,
      pendingCommissions: {
        count:  pendingCommissions._count.id,
        amount: (pendingCommissions._sum.amount ?? 0),
      },
      recentCommissions,
      feedbackAverage:    feedbackAgg._avg.rating ?? 0,
      feedbackCount:      feedbackAgg._count.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /ads — ads managed by this rep ──────────────────────────────────────

router.get('/ads', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rep = await prisma.salesRep.findUnique({ where: { userid: req.user!.id } });
    if (!rep) return res.status(404).json({ error: 'Not a sales rep' });

    const ads = await prisma.ad.findMany({
      where:   { salesrepid: rep.id },
      orderBy: { createdat: 'desc' },
      select: { id: true, title: true, impressions: true, clicks: true, spent: true, active: true, createdat: true },
    });

    res.json(ads);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /ads/:adId/commission — record commission ───────────────────────────

const CommissionSchema = z.object({
  amount: z.number().positive(),
  rate:   z.number().optional(),
});

router.post('/ads/:adId/commission', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = CommissionSchema.parse(req.body);

    const rep = await prisma.salesRep.findUnique({ where: { userid: req.user!.id } });
    if (!rep) return res.status(404).json({ error: 'Not a sales rep' });

    const ad = await prisma.ad.findUnique({ where: { id: qsr(req.params.adId) } });
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.salesrepid !== rep.id) return res.status(403).json({ error: 'This ad is not assigned to you' });

    const commission = await prisma.commission.create({
      data: {
        salesrepid: rep.id,
        adid:       qsr(req.params.adId),
        amount:     body.amount,
        rate:       body.rate,
        status:     'PENDING',
      },
    });

    res.status(201).json(commission);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET / — admin: list all reps ────────────────────────────────────────────

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });

    const reps = await prisma.salesRep.findMany({
      orderBy: { createdat: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, avatarurl: true } },
        _count: { select: { commissions: true, ads: true, feedback: true } },
      },
    });

    res.json(reps);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
