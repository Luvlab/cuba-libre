import { qs, qsr, qsn } from '../utils/query';
/**
 * rides.ts — Ride-share and delivery routes for Cuba Libre
 * Uses Libre as the native currency. Base fare: 50 Libre + 10 Libre/km.
 * Drivers can apply, toggle availability, accept, and complete rides.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

const BASE_FARE_LIBRE  = 50n;
const PER_KM_LIBRE     = 10n;

// ─── Helper: credit/debit Libre ───────────────────────────────────────────────

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
        lifetimeearned: amount > 0n ? { increment: amount } : undefined,
      },
      create: {
        userid:         userId,
        balance:        amount,
        lifetimeearned: amount > 0n ? amount : 0n,
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

async function debitLibre(
  userId: string,
  amount: bigint,
  type: string,
  description: string,
  referenceId?: string,
) {
  await prisma.$transaction(async (tx) => {
    const wallet = await tx.libreWallet.findUnique({ where: { userid: userId } });
    if (!wallet || wallet.balance < amount) throw new Error('Saldo de Libre insuficiente');

    const updated = await tx.libreWallet.update({
      where: { userid: userId },
      data:  {
        balance:      { decrement: amount },
        lifetimespent: { increment: amount },
      },
    });

    await tx.libreTransaction.create({
      data: {
        walletid:     wallet.id,
        amount:       -amount,
        type:         type as any,
        description,
        referenceid:  referenceId,
        balanceafter: updated.balance,
      },
    });
  });
}

function estimatePrice(distanceKm?: number): bigint {
  if (!distanceKm) return BASE_FARE_LIBRE;
  return BASE_FARE_LIBRE + BigInt(Math.ceil(distanceKm)) * PER_KM_LIBRE;
}

// ─── POST /rides/request ─────────────────────────────────────────────────────

const RequestRideSchema = z.object({
  type:           z.enum(['PASSENGER', 'DELIVERY']).default('PASSENGER'),
  pickupaddress:  z.string().optional(),
  dropoffaddress: z.string().optional(),
  pickuplat:      z.number().optional(),
  pickuplng:      z.number().optional(),
  dropofflat:     z.number().optional(),
  dropofflng:     z.number().optional(),
  notes:          z.string().optional(),
  packagedesc:    z.string().optional(),
  weight:         z.number().optional(),
  distance:       z.number().optional(),
  province:       z.string().optional(),
  city:           z.string().optional(),
  scheduledat:    z.string().datetime().optional(),
  currency:       z.string().default('LIBRE'),
});

router.post('/request', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = RequestRideSchema.parse(req.body);
    const estimatedprice = Number(estimatePrice(body.distance));

    const ride = await prisma.rideRequest.create({
      data: {
        ...body,
        userid:          req.user!.id,
        estimatedprice,
        scheduledat:     body.scheduledat ? new Date(body.scheduledat) : undefined,
      },
    });

    res.status(201).json(ride);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /rides/available-drivers ────────────────────────────────────────────

router.get('/available-drivers', async (req, res) => {
  try {
    const { province, service } = req.query as Record<string, string>;
    const where: any = { available: true, verified: true };
    if (province) where.province = province;
    if (service)  where.services = { has: service };

    const drivers = await prisma.driverProfile.findMany({
      where,
      orderBy: { rating: 'desc' },
      include: { user: { select: { id: true, name: true, avatarurl: true } } },
    });

    res.json(drivers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rides/driver/apply ─────────────────────────────────────────────────

const DriverApplySchema = z.object({
  vehicletype: z.string().optional(),
  services:    z.array(z.string()).default(['PASSENGER']),
  platenumber: z.string().optional(),
  licenseno:   z.string().optional(),
  city:        z.string().optional(),
  province:    z.string().optional(),
  bio:         z.string().optional(),
  photourl:    z.string().url().optional(),
});

router.post('/driver/apply', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = DriverApplySchema.parse(req.body);
    const existing = await prisma.driverProfile.findUnique({ where: { userid: req.user!.id } });
    if (existing) return res.status(409).json({ error: 'Driver profile already exists', driver: existing });

    const driver = await prisma.driverProfile.create({
      data: { ...body, userid: req.user!.id },
    });

    res.status(201).json(driver);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /rides/driver/toggle-availability ─────────────────────────────────

router.patch('/driver/toggle-availability', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const driver = await prisma.driverProfile.findUnique({ where: { userid: req.user!.id } });
    if (!driver) return res.status(404).json({ error: 'Driver profile not found' });

    const updated = await prisma.driverProfile.update({
      where: { userid: req.user!.id },
      data:  { available: !driver.available },
    });

    res.json({ available: updated.available });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /rides/:id/accept ────────────────────────────────────────────────────

router.put('/:id/accept', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const driver = await prisma.driverProfile.findUnique({ where: { userid: req.user!.id } });
    if (!driver) return res.status(403).json({ error: 'Not a driver' });

    const ride = await prisma.rideRequest.findUnique({ where: { id: qsr(req.params.id) } });
    if (!ride)                         return res.status(404).json({ error: 'Ride not found' });
    if (ride.status !== 'PENDING')     return res.status(409).json({ error: 'Ride no longer available' });

    const updated = await prisma.rideRequest.update({
      where: { id: qsr(req.params.id) },
      data:  { driverid: driver.id, status: 'ACCEPTED' },
    });

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /rides/:id/complete ──────────────────────────────────────────────────

router.put('/:id/complete', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const driver = await prisma.driverProfile.findUnique({ where: { userid: req.user!.id } });
    if (!driver) return res.status(403).json({ error: 'Not a driver' });

    const ride = await prisma.rideRequest.findUnique({ where: { id: qsr(req.params.id) } });
    if (!ride)                          return res.status(404).json({ error: 'Ride not found' });
    if (ride.driverid !== driver.id)    return res.status(403).json({ error: 'Not your ride' });
    if (ride.status !== 'ACCEPTED')     return res.status(409).json({ error: 'Ride not in progress' });

    const amount = ride.estimatedprice
      ? BigInt(Math.round(ride.estimatedprice))
      : estimatePrice(ride.distance ?? undefined);

    // Deduct from rider, credit to driver
    if (ride.currency === 'LIBRE') {
      await debitLibre(ride.userid, amount, 'SPEND_RIDE', `Ride payment — ${ride.id}`, ride.id);
      await creditLibre(driver.userid, amount, 'EARN_LISTING', `Ride fare received — ${ride.id}`, ride.id);
    }

    const updated = await prisma.rideRequest.update({
      where: { id: qsr(req.params.id) },
      data:  { status: 'COMPLETED', completedat: new Date(), finalprice: Number(amount) },
    });

    await prisma.driverProfile.update({
      where: { id: driver.id },
      data:  { totalrides: { increment: 1 } },
    });

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /rides/my-rides ─────────────────────────────────────────────────────

router.get('/my-rides', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [rides, total] = await Promise.all([
      prisma.rideRequest.findMany({
        where:   { userid: req.user!.id },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { driver: { include: { user: { select: { name: true, avatarurl: true } } } } },
      }),
      prisma.rideRequest.count({ where: { userid: req.user!.id } }),
    ]);

    res.json({ rides, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /rides/driver/my-rides ───────────────────────────────────────────────

router.get('/driver/my-rides', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const driver = await prisma.driverProfile.findUnique({ where: { userid: req.user!.id } });
    if (!driver) return res.status(403).json({ error: 'Not a driver' });

    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [rides, total] = await Promise.all([
      prisma.rideRequest.findMany({
        where:   { driverid: driver.id },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { user: { select: { id: true, name: true, avatarurl: true } } },
      }),
      prisma.rideRequest.count({ where: { driverid: driver.id } }),
    ]);

    res.json({ rides, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
