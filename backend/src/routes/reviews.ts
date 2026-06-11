import { qs, qsr, qsn } from '../utils/query';
/**
 * reviews.ts — Listing reviews for Cuba Libre
 * Writing a review earns 25 Libre (EARN_REVIEW).
 * Supports helpful votes and owner replies.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { creditLibre } from './libre';

const router = Router();

const EARN_REVIEW = 25n;

// ─── Schema ───────────────────────────────────────────────────────────────────

const ReviewSchema = z.object({
  rating:  z.number().int().min(1).max(5),
  comment: z.string().optional(),
});

// ─── GET /reviews/listing/:listingId ─────────────────────────────────────────

router.get('/listing/:listingId', async (req, res) => {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where:   { listingid: qsr(req.params.listingId) },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { user: { select: { id: true, name: true, avatarurl: true } } },
      }),
      prisma.review.count({ where: { listingid: qsr(req.params.listingId) } }),
    ]);

    res.json({ reviews, total, page: parseInt(page) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /reviews/listing/:listingId ────────────────────────────────────────

router.post('/listing/:listingId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body    = ReviewSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: qsr(req.params.listingId) } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    // One review per user per listing
    const existing = await prisma.review.findFirst({
      where: { listingid: qsr(req.params.listingId), userid: req.user!.id },
    });
    if (existing) return res.status(409).json({ error: 'Ya dejaste una reseña para este lugar' });

    const review = await prisma.$transaction(async (tx) => {
      const r = await tx.review.create({
        data: { ...body, listingid: qsr(req.params.listingId), userid: req.user!.id },
      });

      // Update listing average rating
      const all = await tx.review.findMany({
        where:  { listingid: qsr(req.params.listingId) },
        select: { rating: true },
      });
      const avg = all.reduce((sum, r) => sum + r.rating, 0) / all.length;

      await tx.listing.update({
        where: { id: qsr(req.params.listingId) },
        data:  { avgrating: avg, reviewcount: all.length },
      });

      return r;
    });

    // Award Libre
    await creditLibre(req.user!.id, EARN_REVIEW, 'EARN_REVIEW', `Review posted for listing ${qsr(req.params.listingId)}`, review.id);

    res.status(201).json({ review, earned: EARN_REVIEW.toString() });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /reviews/:id/helpful ────────────────────────────────────────────────

router.post('/:id/helpful', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const updated = await prisma.review.update({
      where: { id: qsr(req.params.id) },
      data:  { helpfulcount: { increment: 1 } },
    });
    res.json({ helpfulcount: updated.helpfulcount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /reviews/:id/owner-reply ───────────────────────────────────────────

router.post('/:id/owner-reply', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { reply } = z.object({ reply: z.string().min(1) }).parse(req.body);

    const review = await prisma.review.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: true },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });

    const isOwner = review.listing?.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Only the listing owner can reply' });

    const updated = await prisma.review.update({
      where: { id: qsr(req.params.id) },
      data:  { ownerreply: reply },
    });

    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
