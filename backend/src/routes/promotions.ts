import { qs, qsr, qsn } from '../utils/query';
/**
 * promotions.ts — Business promotion campaigns for Cuba Libre
 * Discounts, coupons, and time-limited offers tied to directory listings.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── GET / — list active promotions ──────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const { listingId, province, limit = '10' } = req.query as Record<string, string>;
    const take = Math.min(parseInt(limit) || 10, 50);
    const now  = new Date();

    const where: any = { active: true, enddate: { gt: now } };
    if (listingId) where.listingid  = listingId;
    if (province)  where.listing    = { province };

    const promotions = await prisma.businessPromotion.findMany({
      where,
      take,
      orderBy: { createdat: 'desc' },
    });

    res.json(promotions);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /:id — get promotion by id ──────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const promo = await prisma.businessPromotion.findUnique({
      where:   { id: qsr(req.params.id) },
      include: {
        listing: { select: { name: true, province: true, logourl: true } },
      },
    });
    if (!promo) return res.status(404).json({ error: 'Promotion not found' });
    res.json(promo);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST / — create promotion ────────────────────────────────────────────────

const CreatePromoSchema = z.object({
  listingId:   z.string().uuid(),
  type:        z.string().min(1),
  title:       z.string().min(2),
  description: z.string().optional(),
  imageurl:    z.string().url().optional(),
  discount:    z.number().optional(),
  couponcode:  z.string().optional(),
  startdate:   z.string().datetime(),
  enddate:     z.string().datetime(),
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = CreatePromoSchema.parse(req.body);

    // Validate listing belongs to the user
    const listing = await prisma.listing.findUnique({ where: { id: body.listingId } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.submittedbyid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'You do not own this listing' });
    }

    const promo = await prisma.businessPromotion.create({
      data: {
        listingid:   body.listingId,
        type:        body.type,
        title:       body.title,
        description: body.description,
        imageurl:    body.imageurl,
        discount:    body.discount,
        couponcode:  body.couponcode,
        startdate:   new Date(body.startdate),
        enddate:     new Date(body.enddate),
        active:      true,
      },
    });

    res.status(201).json(promo);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PATCH /:id — update promotion ────────────────────────────────────────────

router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const promo = await prisma.businessPromotion.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: { select: { submittedbyid: true } } },
    });
    if (!promo) return res.status(404).json({ error: 'Promotion not found' });

    if (promo.listing?.submittedbyid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only the listing owner can update this promotion' });
    }

    const body = CreatePromoSchema.partial().parse(req.body);
    const updated = await prisma.businessPromotion.update({
      where: { id: qsr(req.params.id) },
      data:  {
        ...body,
        listingid:  undefined, // listingId cannot be changed
        startdate:  body.startdate ? new Date(body.startdate) : undefined,
        enddate:    body.enddate   ? new Date(body.enddate)   : undefined,
      },
    });

    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE /:id — soft delete (set active=false) ─────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const promo = await prisma.businessPromotion.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: { select: { submittedbyid: true } } },
    });
    if (!promo) return res.status(404).json({ error: 'Promotion not found' });

    if (promo.listing?.submittedbyid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only the listing owner can delete this promotion' });
    }

    await prisma.businessPromotion.update({
      where: { id: qsr(req.params.id) },
      data:  { active: false },
    });

    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /:id/click — track click ───────────────────────────────────────────

router.post('/:id/click', optionalAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const promo = await prisma.businessPromotion.findUnique({ where: { id: qsr(_req.params.id) } });
    if (!promo) return res.status(404).json({ error: 'Promotion not found' });

    await prisma.businessPromotion.update({
      where: { id: qsr(_req.params.id) },
      data:  { clicks: { increment: 1 } },
    });

    res.json({ clicked: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
