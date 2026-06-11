import { qs, qsr, qsn } from '../utils/query';
/**
 * solidarity.ts — Solidarity Network for Cuba Libre
 * Handles Stripe checkout creation, webhook processing, gift feed,
 * and emergency pool distribution. Libre is credited on payment success.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { USD_TO_LIBRE } from '../config';
import { creditLibre } from './libre';

const router = Router();

// ─── Solidarity Tiers ─────────────────────────────────────────────────────────

const SOLIDARITY_TIERS: Record<string, { label: string; usd: number; libre: number; desc: string }> = {
  amigo:        { label: 'Amigo',        usd: 3,  libre: 300,  desc: 'A small gesture of love' },
  companero:    { label: 'Compañero',    usd: 10, libre: 1200, desc: 'Walking alongside the Cuban people' },
  patrocinador: { label: 'Patrocinador', usd: 25, libre: 3500, desc: 'A powerful act of solidarity' },
};

// ─── GET /solidarity/tiers ────────────────────────────────────────────────────

router.get('/tiers', (_req: Request, res: Response) => {
  res.json(SOLIDARITY_TIERS);
});

// ─── POST /solidarity/stripe/checkout ────────────────────────────────────────

const CheckoutSchema = z.object({
  tier:        z.enum(['amigo', 'companero', 'patrocinador'] as [string, ...string[]]),
  targetType:  z.enum(['USER', 'BUSINESS', 'PROVINCE', 'EMERGENCY_POOL']),
  toUserId:    z.string().optional(),
  toProvince:  z.string().optional(),
  toListingId: z.string().optional(),
  fromName:    z.string().optional(),
  fromEmail:   z.string().email().optional(),
  message:     z.string().optional(),
  anonymous:   z.boolean().default(false),
});

router.post('/stripe/checkout', async (req: Request, res: Response) => {
  try {
    const body = CheckoutSchema.parse(req.body);
    const tierData = SOLIDARITY_TIERS[body.tier];
    if (!tierData) return res.status(400).json({ error: 'Invalid tier' });

    const stripe = (await import('stripe')).default;
    const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any });

    const libreamount = BigInt(Math.round(tierData.usd * USD_TO_LIBRE));

    // Create a pending gift record first
    const gift = await prisma.solidarityGift.create({
      data: {
        fromname:    body.fromName,
        fromemail:   body.fromEmail,
        targettype:  body.targetType as any,
        touserid:    body.toUserId,
        toprovince:  body.toProvince,
        libreamount,
        usdamount:   tierData.usd,
        message:     body.message,
        anonymous:   body.anonymous,
        status:      'PENDING',
      },
    });

    const successUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/solidarity/success?gift=${gift.id}`;
    const cancelUrl  = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/solidarity`;

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency:     'usd',
          unit_amount:  Math.round(tierData.usd * 100),
          product_data: {
            name:        `Cuba Libre — ${tierData.label}`,
            description: tierData.desc,
          },
        },
        quantity: 1,
      }],
      mode:        'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: {
        giftId:     gift.id,
        targetType: body.targetType,
        toUserId:   body.toUserId ?? '',
        toProvince: body.toProvince ?? '',
      },
    });

    await prisma.solidarityGift.update({
      where: { id: gift.id },
      data:  { stripepaymentid: session.id },
    });

    res.json({ url: session.url, giftId: gift.id });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /solidarity/stripe/webhook ─────────────────────────────────────────

router.post('/stripe/webhook', async (req: Request, res: Response) => {
  try {
    const stripe = (await import('stripe')).default;
    const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any });

    const sig     = req.headers['stripe-signature'] as string;
    const secret  = process.env.STRIPE_WEBHOOK_SECRET!;
    let event: any;

    try {
      event = stripeClient.webhooks.constructEvent(req.body, sig, secret);
    } catch (err: any) {
      return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
    }

    if (event.type === 'checkout.session.completed') {
      const session  = event.data.object as any;
      const giftId   = session.metadata?.giftId;

      const gift = await prisma.solidarityGift.findUnique({ where: { id: giftId } });
      if (!gift || gift.status !== 'PENDING') return res.json({ received: true });

      await prisma.solidarityGift.update({
        where: { id: giftId },
        data:  { status: 'COMPLETED', distributedat: new Date() },
      });

      const amount = gift.libreamount;

      if (gift.targettype === 'USER' && gift.touserid) {
        await creditLibre(gift.touserid, amount, 'EARN_SOLIDARITY', `Solidarity gift — ${gift.fromname ?? 'anonymous'}`, giftId);
      }

      if (gift.targettype === 'PROVINCE' && gift.toprovince) {
        const users = await prisma.user.findMany({
          where: { province: gift.toprovince },
          select: { id: true },
        });
        if (users.length > 0) {
          const share = amount / BigInt(users.length);
          for (const u of users) {
            await creditLibre(u.id, share, 'EARN_SOLIDARITY', `Provincial solidarity — ${gift.toprovince}`, giftId);
          }
        }
      }

      if (gift.targettype === 'EMERGENCY_POOL') {
        await prisma.emergencyPool.upsert({
          where:  { id: 'singleton' },
          update: { balance: { increment: amount }, totalin: { increment: amount } },
          create: { id: 'singleton', balance: amount, totalin: amount, totalout: 0n },
        });
      }

      if (gift.targettype === 'BUSINESS') {
        // Find listing linked via metadata, credit listing owner
        const listingId = session.metadata?.toListingId;
        if (listingId) {
          const listing = await prisma.listing.findUnique({ where: { id: listingId } });
          if (listing?.submittedbyid) {
            await creditLibre(listing.submittedbyid ?? "",  amount, 'EARN_SOLIDARITY', `Business solidarity gift`, giftId);
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /solidarity/gifts ────────────────────────────────────────────────────

router.get('/gifts', async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [gifts, total] = await Promise.all([
      prisma.solidarityGift.findMany({
        where:   { status: 'COMPLETED', anonymous: false },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        select: {
          id:          true,
          fromname:    true,
          targettype:  true,
          toprovince:  true,
          libreamount: true,
          usdamount:   true,
          message:     true,
          createdat:   true,
        },
      }),
      prisma.solidarityGift.count({ where: { status: 'COMPLETED', anonymous: false } }),
    ]);

    res.json({
      gifts: gifts.map(g => ({ ...g, libreamount: g.libreamount.toString() })),
      total,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /solidarity/emergency-pool ──────────────────────────────────────────

router.get('/emergency-pool', async (_req: Request, res: Response) => {
  try {
    const pool = await prisma.emergencyPool.findUnique({ where: { id: 'singleton' } });
    res.json({
      balance:  (pool?.balance ?? 0n).toString(),
      totalin:  (pool?.totalin  ?? 0n).toString(),
      totalout: (pool?.totalout ?? 0n).toString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /solidarity/emergency-pool/distribute ───────────────────────────────

const DistributeSchema = z.object({
  toUserId:    z.string().uuid().optional(),
  toProvince:  z.string().optional(),
  amount:      z.number().int().positive(),
  reason:      z.string().optional(),
});

router.post('/emergency-pool/distribute', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
    const body   = DistributeSchema.parse(req.body);
    const amount = BigInt(body.amount);

    const pool = await prisma.emergencyPool.findUnique({ where: { id: 'singleton' } });
    if (!pool || pool.balance < amount) return res.status(400).json({ error: 'Insufficient pool balance' });

    await prisma.emergencyPool.update({
      where: { id: 'singleton' },
      data:  { balance: { decrement: amount }, totalout: { increment: amount } },
    });

    if (body.toUserId) {
      await creditLibre(body.toUserId, amount, 'EARN_SOLIDARITY', body.reason ?? 'Emergency pool distribution');
    } else if (body.toProvince) {
      const users = await prisma.user.findMany({
        where: { province: body.toProvince },
        select: { id: true },
      });
      if (users.length > 0) {
        const share = amount / BigInt(users.length);
        for (const u of users) {
          await creditLibre(u.id, share, 'EARN_SOLIDARITY', `Emergency distribution — ${body.toProvince}`);
        }
      }
    }

    res.json({ success: true, distributed: amount.toString() });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
