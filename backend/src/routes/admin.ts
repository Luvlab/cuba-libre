import { qs, qsr, qsn } from '../utils/query';
/**
 * admin.ts — Admin panel routes for Cuba Libre
 * All routes require ADMIN role. Covers platform stats, listing verification
 * (triggers ambassador kickback + user Libre), user management, events,
 * solidarity gifts, manual Libre grants, and emergency pool.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { creditLibre } from './libre';

const router = Router();

// ─── Admin gate middleware ────────────────────────────────────────────────────

router.use(requireAuth, (req: AuthRequest, res: Response, next) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  next();
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
  try {
    const [users, listings, events, classifieds, solidarityGifts, poolData] = await Promise.all([
      prisma.user.count(),
      prisma.listing.count({ where: { active: true } }),
      prisma.event.count(),
      prisma.classified.count({ where: { status: 'ACTIVE' } }),
      prisma.solidarityGift.aggregate({ where: { status: 'COMPLETED' }, _sum: { usdamount: true } }),
      prisma.emergencyPool.findUnique({ where: { id: 'singleton' } }),
    ]);

    const walletStats = await prisma.libreWallet.aggregate({
      _sum: { balance: true, lifetimeearned: true },
    });

    res.json({
      users,
      listings,
      events,
      classifieds,
      totalSolidarityUsd:  solidarityGifts._sum.usdamount ?? 0,
      emergencyPoolBalance: (poolData?.balance ?? 0n).toString(),
      libreInCirculation:  (walletStats._sum.balance ?? 0n).toString(),
      libreEverEarned:     (walletStats._sum.lifetimeearned ?? 0n).toString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/listings ──────────────────────────────────────────────────────

router.get('/listings', async (req, res) => {
  try {
    const { verified, province, page = '1', limit = '50' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where: any = {};
    if (province)            where.province = province;
    if (verified !== undefined) where.verified = verified === 'true';

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { enteredBy: { include: { user: { select: { name: true, avatarurl: true } } } } },
      }),
      prisma.listing.count({ where }),
    ]);

    res.json({ listings, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /admin/listings/:id/verify ────────────────────────────────────────

router.patch('/listings/:id/verify', async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { enteredBy: true },
    });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    await prisma.listing.update({ where: { id: qsr(req.params.id) }, data: { verified: true } });

    // Credit user 50 Libre
    if (listing.submittedbyid) {
      await creditLibre(listing.submittedbyid, 50n, 'EARN_LISTING', `Listing verified: ${listing.name}`, listing.id);
    }

    // Ambassador kickback ($2 USD equivalent)
    if (listing.enteredBy) {
      await prisma.ambassador.update({
        where: { id: listing.enteredBy.id },
        data: {
          totalearned:   { increment: listing.enteredBy.listingkickback },
          pendingpayout: { increment: listing.enteredBy.listingkickback },
        },
      });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/users ─────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  try {
    const { role, province, page = '1', limit = '50' } = req.query as Record<string, string>;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const where: any = {};
    if (role)     where.role     = role;
    if (province) where.province = province;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        select: {
          id: true, name: true, email: true, phone: true,
          role: true, province: true, createdat: true,
          wallet: { select: { balance: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users: users.map(u => ({
        ...u,
        libreBalance: (u.wallet?.balance ?? 0n).toString(),
        wallet: undefined,
      })),
      total,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/events ────────────────────────────────────────────────────────

router.get('/events', async (req, res) => {
  try {
    const { status = 'PENDING', page = '1', limit = '50' } = req.query as Record<string, string>;
    const skip  = (parseInt(page) - 1) * parseInt(limit);

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where:   { status: status as any },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { submittedBy: { select: { id: true, name: true } } },
      }),
      prisma.event.count({ where: { status: status as any } }),
    ]);

    res.json({ events, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /admin/events/:id/status ──────────────────────────────────────────

router.patch('/events/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'FEATURED', 'CANCELLED']) }).parse(req.body);
    const event = await prisma.event.findUnique({ where: { id: qsr(req.params.id) } });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    await prisma.event.update({
      where: { id: qsr(req.params.id) },
      data:  { status: status as any, featuredbyid: status === 'FEATURED' ? req.user!.id : undefined },
    });

    if ((status === 'APPROVED' || status === 'FEATURED') && event.submittedbyid && event.status === 'PENDING') {
      await creditLibre(event.submittedbyid, 25n, 'EARN_LISTING', `Event approved: ${event.title}`, event.id);
    }

    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/solidarity ────────────────────────────────────────────────────

router.get('/solidarity', async (req, res) => {
  try {
    const { status, page = '1', limit = '50' } = req.query as Record<string, string>;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const where: any = {};
    if (status) where.status = status;

    const [gifts, total] = await Promise.all([
      prisma.solidarityGift.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
      }),
      prisma.solidarityGift.count({ where }),
    ]);

    res.json({
      gifts: gifts.map(g => ({ ...g, libreamount: g.libreamount.toString() })),
      total,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /admin/libre/grant ──────────────────────────────────────────────────

const GrantSchema = z.object({
  userId:      z.string().uuid(),
  amount:      z.number().int().positive(),
  reason:      z.string().optional(),
  type:        z.string().default('EARN_CODE'),
});

router.post('/libre/grant', async (req: AuthRequest, res: Response) => {
  try {
    const body = GrantSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    await creditLibre(body.userId, BigInt(body.amount), body.type, body.reason ?? `Admin grant by ${req.user!.id}`);
    res.json({ success: true, granted: body.amount });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /admin/emergency-pool ────────────────────────────────────────────────

router.get('/emergency-pool', async (_req, res) => {
  try {
    const pool = await prisma.emergencyPool.findUnique({ where: { id: 'singleton' } });
    res.json({
      balance:  (pool?.balance  ?? 0n).toString(),
      totalin:  (pool?.totalin  ?? 0n).toString(),
      totalout: (pool?.totalout ?? 0n).toString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
