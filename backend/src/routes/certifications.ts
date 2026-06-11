import { qs, qsr, qsn } from '../utils/query';
/**
 * certifications.ts — Cuba Certification & Award system for Cuba Libre
 * Verifies Pro sticker codes, lists certifications per listing,
 * checks eligibility automatically, and lets admins create Cuba Awards.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── GET /certifications/verify/:code ────────────────────────────────────────

router.get('/verify/:code', async (req, res) => {
  try {
    const subscription = await prisma.proSubscription.findUnique({
      where:   { stickercode: qsr(req.params.code) },
      include: { listing: { select: { id: true, name: true, province: true, category: true, logourl: true } } },
    });

    if (!subscription) return res.status(404).json({ error: 'Código no encontrado', valid: false });
    if (!subscription.active) return res.json({ valid: false, expired: true, listing: subscription.listing });

    res.json({
      valid:     true,
      listing:   subscription.listing,
      plan:      subscription.plan,
      startdate: subscription.startdate,
      enddate:   subscription.enddate,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /certifications/listing/:id ─────────────────────────────────────────

router.get('/listing/:id', async (req, res) => {
  try {
    const [certification, awards, proSubscription] = await Promise.all([
      prisma.cubaCertification.findUnique({
        where: { listingid: qsr(req.params.id) },
      }),
      prisma.cubaAward.findMany({
        where:   { listingid: qsr(req.params.id) },
        orderBy: { year: 'desc' },
      }),
      prisma.proSubscription.findUnique({
        where: { listingid: qsr(req.params.id) },
      }),
    ]);

    res.json({ certification, awards, proSubscription });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /certifications/check-eligibility/:id ──────────────────────────────

router.post('/check-eligibility/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { reviews: { select: { rating: true } } },
    });

    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const isOwner = listing.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Owner access required' });

    const avgRating   = listing.reviews.length > 0
      ? listing.reviews.reduce((s, r) => s + r.rating, 0) / listing.reviews.length
      : 0;
    const reviewCount = listing.reviews.length;

    const eligible: string[] = [];
    const reasons: string[]  = [];

    if (!listing.verified) {
      reasons.push('Listing must be verified first');
    } else {
      if (avgRating >= 4.5 && reviewCount >= 5) eligible.push('GOLD');
      if (avgRating >= 4.0 && reviewCount >= 3) eligible.push('SILVER');
      if (listing.ispro && avgRating >= 4.5 && reviewCount >= 10) eligible.push('PLATINUM');
    }

    res.json({
      listingId:   listing.id,
      eligible,
      avgRating:   Math.round(avgRating * 10) / 10,
      reviewCount,
      isPro:       listing.ispro,
      verified:    listing.verified,
      reasons,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /certifications/award ───────────────────────────────────────────────

const AwardSchema = z.object({
  listingid: z.string().uuid(),
  title:     z.string().min(3),
  year:      z.number().int().optional(),
  category:  z.string().optional(),
  imageurl:  z.string().url().optional(),
  rank:      z.number().int().default(1),
});

router.post('/award', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });

    const body  = AwardSchema.parse(req.body);
    const award = await prisma.cubaAward.create({ data: body });
    res.status(201).json(award);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
