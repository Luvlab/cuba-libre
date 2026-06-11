import { qs, qsr, qsn } from '../utils/query';
/**
 * ambassador.ts — Ambassador program for Cuba Libre
 * Ambassadors earn a kickback per verified listing and per Pro subscription sold.
 * Province-based leaderboard and dashboard for earning tracking.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';

const router = Router();

// ─── POST /ambassador/apply ───────────────────────────────────────────────────

const ApplySchema = z.object({
  province: z.enum(CUBA_PROVINCES as [string, ...string[]]).optional(),
  city:     z.string().optional(),
});

router.post('/apply', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.ambassador.findUnique({ where: { userid: req.user!.id } });
    if (existing) return res.status(409).json({ error: 'Ya eres embajador', ambassador: existing });

    const body = ApplySchema.parse(req.body);
    const ambassador = await prisma.ambassador.create({
      data: { userid: req.user!.id, ...body },
    });

    // Upgrade role to AMBASSADOR
    await prisma.user.update({
      where: { id: req.user!.id },
      data:  { role: 'AMBASSADOR' },
    });

    res.status(201).json(ambassador);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /ambassador/dashboard ────────────────────────────────────────────────

router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ambassador = await prisma.ambassador.findUnique({
      where:   { userid: req.user!.id },
      include: {
        listingsEntered: {
          select: { id: true, name: true, province: true, verified: true, createdat: true },
          orderBy: { createdat: 'desc' },
          take: 10,
        },
        payouts: { orderBy: { createdat: 'desc' }, take: 5 },
      },
    });

    if (!ambassador) return res.status(404).json({ error: 'Not an ambassador' });

    res.json({
      ambassador,
      stats: {
        totalListings:   ambassador.listingsEntered.length,
        totalEarned:     ambassador.totalearned,
        pendingPayout:   ambassador.pendingpayout,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /ambassador/listings ────────────────────────────────────────────────

const ListingSchema = z.object({
  type:        z.enum(['PERSONAL', 'BUSINESS', 'GOVERNMENT', 'NGO']),
  name:        z.string().min(2),
  phone:       z.string().optional(),
  email:       z.string().email().optional(),
  address:     z.string().optional(),
  city:        z.string().optional(),
  province:    z.enum(CUBA_PROVINCES as [string, ...string[]]),
  category:    z.string().optional(),
  description: z.string().optional(),
  website:     z.string().url().optional(),
  whatsapp:    z.string().optional(),
  photos:      z.array(z.string()).default([]),
});

router.post('/listings', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const ambassador = await prisma.ambassador.findUnique({ where: { userid: req.user!.id } });
    if (!ambassador) return res.status(403).json({ error: 'Not an ambassador' });

    const body    = ListingSchema.parse(req.body);
    const listing = await prisma.listing.create({
      data: { ...body, submittedbyid: req.user!.id, ambassadorid: ambassador.id },
    });

    res.status(201).json({ listing, message: 'Listing submitted. You\'ll earn $2 when it\'s verified.' });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /ambassador/leaderboard ─────────────────────────────────────────────

router.get('/leaderboard', async (req, res) => {
  try {
    const { province } = req.query as Record<string, string>;
    const where: any = { active: true };
    if (province) where.province = province;

    const ambassadors = await prisma.ambassador.findMany({
      where,
      orderBy: { totalearned: 'desc' },
      take:    20,
      include: { user: { select: { id: true, name: true, avatarurl: true } } },
    });

    const withCounts = await Promise.all(
      ambassadors.map(async (a) => {
        const listingCount = await prisma.listing.count({ where: { enteredbyid: a.id } });
        return {
          id:           a.id,
          name:         a.user.name,
          avatarurl:    a.user.avatarurl,
          province:     a.province,
          totalEarned:  a.totalearned,
          listingCount,
        };
      })
    );

    res.json(withCounts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
