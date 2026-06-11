import { qs, qsr, qsn } from '../utils/query';
/**
 * feedback.ts — Sales rep and platform feedback for Cuba Libre
 * Ratings for sales reps, listing-level feedback, and general platform feedback.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── POST / — submit sales rep feedback ──────────────────────────────────────

const FeedbackSchema = z.object({
  salesRepId: z.string().uuid(),
  listingId:  z.string().uuid(),
  rating:     z.number().int().min(1).max(5),
  comment:    z.string().optional(),
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = FeedbackSchema.parse(req.body);

    const [rep, listing] = await Promise.all([
      prisma.salesRep.findUnique({ where: { id: body.salesRepId } }),
      prisma.listing.findUnique({ where: { id: body.listingId } }),
    ]);

    if (!rep)     return res.status(404).json({ error: 'Sales rep not found' });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const feedback = await prisma.salesFeedback.create({
      data: {
        salesrepid: body.salesRepId,
        listingid:  body.listingId,
        userid:     req.user!.id,
        rating:     body.rating,
        comment:    body.comment,
      },
    });

    res.status(201).json(feedback);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /salesrep/:salesRepId — feedback for a sales rep ────────────────────

router.get('/salesrep/:salesRepId', async (req: Request, res: Response) => {
  try {
    const [feedback, agg] = await Promise.all([
      prisma.salesFeedback.findMany({
        where:   { salesrepid: qsr(req.params.salesRepId) },
        orderBy: { createdat: 'desc' },
      }),
      prisma.salesFeedback.aggregate({
        where: { salesrepid: qsr(req.params.salesRepId) },
        _avg:  { rating: true },
        _count: { id: true },
      }),
    ]);

    res.json({
      feedback,
      averageRating: agg._avg.rating ?? 0,
      totalCount:    agg._count.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /listing/:listingId — sales feedback for a listing ──────────────────

router.get('/listing/:listingId', async (req: Request, res: Response) => {
  try {
    const [feedback, agg] = await Promise.all([
      prisma.salesFeedback.findMany({
        where:   { listingid: qsr(req.params.listingId) },
        orderBy: { createdat: 'desc' },
      }),
      prisma.salesFeedback.aggregate({
        where: { listingid: qsr(req.params.listingId) },
        _avg:  { rating: true },
        _count: { id: true },
      }),
    ]);

    res.json({
      feedback,
      averageRating: agg._avg.rating ?? 0,
      totalCount:    agg._count.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /platform — general platform feedback ───────────────────────────────

const PlatformFeedbackSchema = z.object({
  category: z.enum(['bug', 'feature', 'content', 'other']),
  message:  z.string().min(5),
  contact:  z.string().optional(),
});

router.post('/platform', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = PlatformFeedbackSchema.parse(req.body);

    await prisma.userEvent.create({
      data: {
        userid:    req.user?.id,
        eventtype: 'platform_feedback',
        value:     body.category,
        metadata:  { message: body.message, contact: body.contact },
      },
    });

    res.status(201).json({ received: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
