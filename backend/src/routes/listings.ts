import { qs, qsr, qsn } from '../utils/query';
/**
 * listings.ts — Business/personal listings CRUD for Cuba Libre
 * Supports search, province filter, view counts, nearby (by province),
 * top-rated, and awards 50 Libre (EARN_LISTING) on listing creation/verification.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ListingSchema = z.object({
  type:         z.enum(['PERSONAL', 'BUSINESS', 'GOVERNMENT', 'NGO']),
  name:         z.string().min(2),
  phone:        z.string().optional(),
  phone2:       z.string().optional(),
  email:        z.string().email().optional(),
  address:      z.string().optional(),
  city:         z.string().optional(),
  province:     z.enum(CUBA_PROVINCES as [string, ...string[]]),
  zipcode:      z.string().optional(),
  latitude:     z.number().optional(),
  longitude:    z.number().optional(),
  category:     z.string().optional(),
  subcategory:  z.string().optional(),
  description:  z.string().optional(),
  website:      z.string().url().optional(),
  whatsapp:     z.string().optional(),
  language:     z.string().default('es'),
  logourl:      z.string().url().optional(),
  photos:       z.array(z.string()).default([]),
  openinghours: z.string().optional(),
  bookable:     z.boolean().default(false),
});

// ─── Helper: credit Libre ─────────────────────────────────────────────────────

async function creditLibre(
  userId: string,
  amount: bigint,
  type: string,
  description: string,
  referenceId?: string,
) {
  await prisma.$transaction(async (tx) => {
    const wallet = await tx.libreWallet.upsert({
      where:  { userid: userId },
      update: {
        balance:        { increment: amount },
        lifetimeearned: { increment: amount },
      },
      create: {
        userid:        userId,
        balance:       amount,
        lifetimeearned: amount,
      },
    });

    await tx.libreTransaction.create({
      data: {
        walletid:     wallet.id,
        amount,
        type:         type as any,
        description,
        referenceid:  referenceId,
        balanceafter: wallet.balance,
      },
    });
  });
}

// ─── GET /listings ────────────────────────────────────────────────────────────

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, search, type, verified, page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = { active: true };
    if (province)  where.province = province;
    if (category)  where.category = category;
    if (type)      where.type = type;
    if (verified !== undefined) where.verified = verified === 'true';
    if (search) {
      where.OR = [
        { name:        { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { category:    { contains: search, mode: 'insensitive' } },
        { city:        { contains: search, mode: 'insensitive' } },
      ];
    }

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: [{ ispro: 'desc' }, { avgrating: 'desc' }, { createdat: 'desc' }],
        include: { tags: true },
      }),
      prisma.listing.count({ where }),
    ]);

    res.json({ listings, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /listings ───────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = ListingSchema.parse(req.body);

    const listing = await prisma.listing.create({
      data: { ...body, submittedbyid: req.user!.id },
    });

    // Award Libre for submitting a listing
    await creditLibre(req.user!.id, BigInt(50), 'EARN_LISTING', 'Libre earned for submitting a listing', listing.id);

    res.status(201).json(listing);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /listings/nearby ─────────────────────────────────────────────────────

router.get('/nearby', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, limit = '10' } = req.query as Record<string, string>;
    if (!province) return res.status(400).json({ error: 'province required' });

    const listings = await prisma.listing.findMany({
      where:   { province, active: true, ...(category ? { category } : {}) },
      take:    parseInt(limit),
      orderBy: { avgrating: 'desc' },
      include: { tags: true },
    });

    res.json(listings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /listings/top-rated ──────────────────────────────────────────────────

router.get('/top-rated', async (req, res) => {
  try {
    const { province, category, limit = '20' } = req.query as Record<string, string>;
    const where: any = { active: true, reviewcount: { gt: 0 } };
    if (province) where.province = province;
    if (category) where.category = category;

    const listings = await prisma.listing.findMany({
      where,
      take:    parseInt(limit),
      orderBy: { avgrating: 'desc' },
      include: { tags: true },
    });

    res.json(listings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /listings/:id ────────────────────────────────────────────────────────

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { tags: true, reviews: { take: 5, orderBy: { createdat: 'desc' } } },
    });

    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    // Increment view count async (don't await)
    prisma.listing.update({
      where: { id: listing.id },
      data:  { viewcount: { increment: 1 } },
    }).catch(() => {});

    res.json(listing);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /listings/:id ────────────────────────────────────────────────────────

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: qsr(req.params.id) } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const isOwner = listing.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const body = ListingSchema.partial().parse(req.body);
    const updated = await prisma.listing.update({ where: { id: qsr(req.params.id) }, data: body });
    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /listings/:id ─────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: qsr(req.params.id) } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const isOwner = listing.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    await prisma.listing.update({ where: { id: qsr(req.params.id) }, data: { active: false } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /listings/:id/verify ───────────────────────────────────────────────

router.patch('/:id/verify', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });

    const listing = await prisma.listing.findUnique({ where: { id: qsr(req.params.id) } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    await prisma.listing.update({ where: { id: qsr(req.params.id) }, data: { verified: true } });

    // Credit Libre to listing owner
    if (listing.submittedbyid) {
      await creditLibre(listing.submittedbyid, BigInt(50), 'EARN_LISTING', 'Listing verified — ¡felicitaciones!', listing.id);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
