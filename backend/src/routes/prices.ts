import { qs, qsr, qsn } from '../utils/query';
/**
 * prices.ts — Community price tracker for Cuba Libre
 * Users submit price reports and earn 5 Libre per submission.
 * Supports province/item filters, cross-province comparison, and trending items.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';
import { creditLibre } from './libre';

const router = Router();

const EARN_PRICE_REPORT = 5n;

// ─── Schema ───────────────────────────────────────────────────────────────────

const PriceSchema = z.object({
  item:     z.string().min(2),
  price:    z.number().positive(),
  currency: z.string().default('LIBRE'),
  unit:     z.string().optional(),
  store:    z.string().optional(),
  city:     z.string().optional(),
  province: z.enum(CUBA_PROVINCES as [string, ...string[]]),
  source:   z.string().optional(),
});

// ─── GET /prices ──────────────────────────────────────────────────────────────

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, item, currency, page = '1', limit = '30' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = {};
    if (province) where.province = province;
    if (currency) where.currency = currency;
    if (item)     where.item     = { contains: item, mode: 'insensitive' };

    const [entries, total] = await Promise.all([
      prisma.priceEntry.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
      }),
      prisma.priceEntry.count({ where }),
    ]);

    res.json({ entries, total, page: parseInt(page) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /prices ─────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = PriceSchema.parse(req.body);

    const entry = await prisma.priceEntry.create({ data: body });

    // Earn 5 Libre for price report
    await creditLibre(req.user!.id, EARN_PRICE_REPORT, 'EARN_REVIEW', `Price report: ${body.item} in ${body.province}`, entry.id);

    res.status(201).json({ entry, earned: EARN_PRICE_REPORT.toString() });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /prices/compare ─────────────────────────────────────────────────────

router.get('/compare', async (req, res) => {
  try {
    const { item } = req.query as Record<string, string>;
    if (!item) return res.status(400).json({ error: 'item query param required' });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30 days

    const entries = await prisma.priceEntry.findMany({
      where: {
        item:      { contains: item, mode: 'insensitive' },
        createdat: { gte: since },
      },
      orderBy: { createdat: 'desc' },
    });

    // Group by province and compute avg price
    const byProvince: Record<string, { prices: number[]; entries: typeof entries }> = {};
    for (const e of entries) {
      if (!e.province) continue;
      if (!byProvince[e.province]) byProvince[e.province] = { prices: [], entries: [] };
      byProvince[e.province].prices.push(e.price);
      byProvince[e.province].entries.push(e);
    }

    const comparison = Object.entries(byProvince).map(([province, data]) => ({
      province,
      avgPrice:  data.prices.reduce((a, b) => a + b, 0) / data.prices.length,
      minPrice:  Math.min(...data.prices),
      maxPrice:  Math.max(...data.prices),
      reports:   data.prices.length,
      currency:  data.entries[0]?.currency ?? 'LIBRE',
      latestAt:  data.entries[0]?.createdat,
    }));

    comparison.sort((a, b) => a.avgPrice - b.avgPrice);

    res.json({ item, comparison });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /prices/trending ─────────────────────────────────────────────────────

router.get('/trending', async (_req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const entries = await prisma.priceEntry.groupBy({
      by:      ['item'],
      where:   { createdat: { gte: since } },
      _count:  { item: true },
      orderBy: { _count: { item: 'desc' } },
      take:    20,
    });

    res.json(entries.map(e => ({ item: e.item, reports: e._count.item })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
