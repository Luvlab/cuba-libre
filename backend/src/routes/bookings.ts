import { qs, qsr, qsn } from '../utils/query';
/**
 * bookings.ts — Booking system for Cuba Libre
 * Supports Libre payment deduction on booking creation.
 * Listing owners can view/confirm bookings; users see their own.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const BookingSchema = z.object({
  listingid:    z.string().uuid(),
  service:      z.string().optional(),
  date:         z.string().datetime().optional(),
  duration:     z.number().int().positive().optional(),
  notes:        z.string().optional(),
  totalprice:   z.number().optional(),
  currency:     z.string().default('LIBRE'),
  guestcount:   z.number().int().positive().default(1),
  contactname:  z.string().optional(),
  contactphone: z.string().optional(),
});

// ─── POST /bookings ───────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = BookingSchema.parse(req.body);

    const listing = await prisma.listing.findUnique({ where: { id: body.listingid } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (!listing.bookable) return res.status(400).json({ error: 'Listing does not accept bookings' });

    // Deduct Libre if applicable
    if (body.currency === 'LIBRE' && body.totalprice && body.totalprice > 0) {
      const amount = BigInt(Math.round(body.totalprice));
      await prisma.$transaction(async (tx) => {
        const wallet = await tx.libreWallet.findUnique({ where: { userid: req.user!.id } });
        if (!wallet || wallet.balance < amount) throw new Error('Saldo de Libre insuficiente');

        const updated = await tx.libreWallet.update({
          where: { userid: req.user!.id },
          data:  { balance: { decrement: amount }, lifetimespent: { increment: amount } },
        });

        await tx.libreTransaction.create({
          data: {
            walletid:     wallet.id,
            amount:       -amount,
            type:         'SPEND_BOOKING',
            description:  `Booking: ${listing.name}`,
            referenceid:  body.listingid,
            balanceafter: updated.balance,
          },
        });
      });
    }

    const booking = await prisma.booking.create({
      data: {
        ...body,
        userid: req.user!.id,
        date:   body.date ? new Date(body.date) : undefined,
      },
    });

    res.status(201).json(booking);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    if (err.message.includes('insuficiente')) return res.status(402).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /bookings/my ─────────────────────────────────────────────────────────

router.get('/my', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where:   { userid: req.user!.id },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { listing: { select: { id: true, name: true, province: true, logourl: true } } },
      }),
      prisma.booking.count({ where: { userid: req.user!.id } }),
    ]);

    res.json({ bookings, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /bookings/listing/:listingId ────────────────────────────────────────

router.get('/listing/:listingId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: qsr(req.params.listingId) } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const isOwner = listing.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Owner access required' });

    const { page = '1', limit = '20', status } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where: any = { listingid: qsr(req.params.listingId) };
    if (status) where.status = status;

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { user: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.booking.count({ where }),
    ]);

    res.json({ bookings, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /bookings/:id/status ───────────────────────────────────────────────

const StatusSchema = z.object({
  status: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
  notes:  z.string().optional(),
});

router.patch('/:id/status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = StatusSchema.parse(req.body);

    const booking = await prisma.booking.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: true },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const isOwner = booking.listing?.submittedbyid === req.user!.id;
    const isUser  = booking.userid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';

    // Users can only cancel their own bookings
    if (status === 'CANCELLED' && !isUser && !isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (status !== 'CANCELLED' && !isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Owner access required' });
    }

    const updated = await prisma.booking.update({
      where: { id: qsr(req.params.id) },
      data:  { status: status as any },
    });

    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
