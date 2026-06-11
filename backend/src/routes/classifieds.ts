import { qs, qsr, qsn } from '../utils/query';
/**
 * classifieds.ts — Classified ads for Cuba Libre
 * Posting costs 10 Libre (SPEND_CLASSIFIED). Default currency: LIBRE.
 * Supports province/category/currency filters and SOLD status marking.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';

const router = Router();

const POST_COST = 10n;

// ─── Schema ───────────────────────────────────────────────────────────────────

const ClassifiedSchema = z.object({
  title:       z.string().min(3),
  description: z.string().optional(),
  price:       z.number().optional(),
  currency:    z.string().default('LIBRE'),
  category:    z.string().optional(),
  condition:   z.string().optional(),
  images:      z.array(z.string()).default([]),
  city:        z.string().optional(),
  province:    z.enum(CUBA_PROVINCES as [string, ...string[]]).optional(),
});

// ─── GET /classifieds ─────────────────────────────────────────────────────────

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, currency, search, page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = { status: 'ACTIVE' };
    if (province) where.province = province;
    if (category) where.category = category;
    if (currency) where.currency = currency;
    if (search) {
      where.OR = [
        { title:       { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [classifieds, total] = await Promise.all([
      prisma.classified.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { user: { select: { id: true, name: true, avatarurl: true } } },
      }),
      prisma.classified.count({ where }),
    ]);

    res.json({ classifieds, total, page: parseInt(page) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /classifieds ────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = ClassifiedSchema.parse(req.body);

    // Deduct 10 Libre to post
    await prisma.$transaction(async (tx) => {
      const wallet = await tx.libreWallet.findUnique({ where: { userid: req.user!.id } });
      if (!wallet || wallet.balance < POST_COST) throw new Error('Necesitas 10 Libre para publicar un clasificado');

      const updated = await tx.libreWallet.update({
        where: { userid: req.user!.id },
        data:  { balance: { decrement: POST_COST }, lifetimespent: { increment: POST_COST } },
      });

      await tx.libreTransaction.create({
        data: {
          walletid:     wallet.id,
          amount:       -POST_COST,
          type:         'SPEND_CLASSIFIED',
          description:  `Classified post: ${body.title}`,
          balanceafter: updated.balance,
        },
      });
    });

    const classified = await prisma.classified.create({
      data: { ...body, userid: req.user!.id },
    });

    res.status(201).json(classified);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    if (err.message.includes('Libre')) return res.status(402).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /classifieds/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const classified = await prisma.classified.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { user: { select: { id: true, name: true, avatarurl: true, province: true } } },
    });
    if (!classified) return res.status(404).json({ error: 'Classified not found' });
    res.json(classified);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /classifieds/:id ─────────────────────────────────────────────────────

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const classified = await prisma.classified.findUnique({ where: { id: qsr(req.params.id) } });
    if (!classified) return res.status(404).json({ error: 'Classified not found' });
    if (classified.userid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not your classified' });
    }

    const body    = ClassifiedSchema.partial().parse(req.body);
    const updated = await prisma.classified.update({ where: { id: qsr(req.params.id) }, data: body });
    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /classifieds/:id ──────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const classified = await prisma.classified.findUnique({ where: { id: qsr(req.params.id) } });
    if (!classified) return res.status(404).json({ error: 'Classified not found' });
    if (classified.userid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not your classified' });
    }

    await prisma.classified.update({ where: { id: qsr(req.params.id) }, data: { status: 'DELETED' } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /classifieds/:id/sold ────────────────────────────────────────────────

router.put('/:id/sold', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const classified = await prisma.classified.findUnique({ where: { id: qsr(req.params.id) } });
    if (!classified) return res.status(404).json({ error: 'Classified not found' });
    if (classified.userid !== req.user!.id) return res.status(403).json({ error: 'Not your classified' });

    const updated = await prisma.classified.update({ where: { id: qsr(req.params.id) }, data: { status: 'SOLD' } });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
