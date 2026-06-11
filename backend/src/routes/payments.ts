import { qs, qsr, qsn } from '../utils/query';
/**
 * payments.ts — Solidarity payment processor for Cuba Libre
 * Stripe (international cards) + Airwallex (EU/diaspora).
 * Note: Visa/Mastercard are blocked inside Cuba — Libre is the internal currency.
 * No payment required inside Cuba.
 */

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { USD_TO_LIBRE } from '../config';
import { creditLibre } from './libre';

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const SOLIDARITY_RATES: Record<string, number> = {
  amigo:        3,
  companero:    10,
  patrocinador: 25,
};

// ─── GET /methods ─────────────────────────────────────────────────────────────

router.get('/methods', (_req: Request, res: Response) => {
  res.json({
    methods: [
      {
        id:          'stripe_card',
        label:       'Credit / Debit Card',
        description: 'International Visa/Mastercard — for diaspora and international supporters',
        provider:    'stripe',
      },
      {
        id:          'airwallex',
        label:       'Airwallex',
        description: 'EU and diaspora bank payments via Airwallex',
        provider:    'airwallex',
      },
    ],
    notice: 'Visa/Mastercard are blocked inside Cuba. Libre is the internal currency — no payment needed inside Cuba.',
  });
});

// ─── POST /stripe/checkout ────────────────────────────────────────────────────

const StripeCheckoutSchema = z.object({
  fromName:    z.string().optional(),
  fromCountry: z.string().optional(),
  fromEmail:   z.string().email().optional(),
  targetType:  z.enum(['USER', 'BUSINESS', 'PROVINCE', 'EMERGENCY_POOL']),
  toUserId:    z.string().optional(),
  toProvince:  z.string().optional(),
  tier:        z.enum(['amigo', 'companero', 'patrocinador']),
  message:     z.string().optional(),
  anonymous:   z.boolean().default(false),
});

router.post('/stripe/checkout', async (req: Request, res: Response) => {
  try {
    const body = StripeCheckoutSchema.parse(req.body);
    const usdAmount = SOLIDARITY_RATES[body.tier];
    if (!usdAmount) return res.status(400).json({ error: 'Invalid tier' });

    const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any });
    const libreAmount  = BigInt(Math.round(usdAmount * USD_TO_LIBRE));

    const gift = await prisma.solidarityGift.create({
      data: {
        fromname:   body.fromName,
        fromemail:  body.fromEmail,
        targettype: body.targetType as any,
        touserid:   body.toUserId,
        toprovince: body.toProvince,
        libreamount: libreAmount,
        usdamount:  usdAmount,
        message:    body.message,
        anonymous:  body.anonymous,
        status:     'PENDING',
      },
    });

    const successUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/solidarity/success?gift=${gift.id}`;
    const cancelUrl  = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/solidarity`;

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency:     'usd',
          unit_amount:  Math.round(usdAmount * 100),
          product_data: { name: `Cuba Libre Solidarity — ${body.tier}` },
        },
        quantity: 1,
      }],
      mode:        'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: {
        giftId:     gift.id,
        targetType: body.targetType,
        toUserId:   body.toUserId   ?? '',
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
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /stripe/webhook ─────────────────────────────────────────────────────

router.post('/stripe/webhook', async (req: Request, res: Response) => {
  try {
    const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any });
    const sig          = req.headers['stripe-signature'] as string;
    let event: any;

    try {
      event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err: any) {
      return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const giftId  = session.metadata?.giftId;
      if (!giftId) return res.json({ received: true });

      const gift = await prisma.solidarityGift.findUnique({ where: { id: giftId } });
      if (!gift || gift.status !== 'PENDING') return res.json({ received: true });

      await prisma.solidarityGift.update({
        where: { id: giftId },
        data:  { status: 'COMPLETED', distributedat: new Date() },
      });

      const amount = gift.libreamount;

      if (gift.targettype === 'USER' && gift.touserid) {
        await creditLibre(gift.touserid, amount, 'EARN_SOLIDARITY', `Solidarity gift — ${gift.fromname ?? 'anonymous'}`, giftId);
      } else if (gift.targettype === 'PROVINCE' && gift.toprovince) {
        const users = await prisma.user.findMany({
          where:  { province: gift.toprovince },
          select: { id: true },
        });
        if (users.length > 0) {
          const share = amount / BigInt(users.length);
          for (const u of users) {
            await creditLibre(u.id, share, 'EARN_SOLIDARITY', `Provincial solidarity — ${gift.toprovince}`, giftId);
          }
        }
      } else if (gift.targettype === 'EMERGENCY_POOL') {
        await prisma.emergencyPool.upsert({
          where:  { id: 'singleton' },
          update: { balance: { increment: amount }, totalin: { increment: amount } },
          create: { id: 'singleton', balance: amount, totalin: amount, totalout: 0n },
        });
      } else if (gift.targettype === 'BUSINESS') {
        const listingId = session.metadata?.toListingId;
        if (listingId) {
          const listing = await prisma.listing.findUnique({ where: { id: listingId } });
          if (listing?.submittedbyid) {
            await creditLibre(listing.submittedbyid ?? "",  amount, 'EARN_SOLIDARITY', 'Business solidarity gift', giftId);
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /airwallex/checkout ─────────────────────────────────────────────────

const AirwallexCheckoutSchema = z.object({
  fromName:    z.string().optional(),
  fromCountry: z.string().optional(),
  fromEmail:   z.string().email().optional(),
  targetType:  z.enum(['USER', 'BUSINESS', 'PROVINCE', 'EMERGENCY_POOL']),
  toUserId:    z.string().optional(),
  toProvince:  z.string().optional(),
  tier:        z.enum(['amigo', 'companero', 'patrocinador']),
  message:     z.string().optional(),
  anonymous:   z.boolean().default(false),
});

router.post('/airwallex/checkout', async (req: Request, res: Response) => {
  try {
    const body      = AirwallexCheckoutSchema.parse(req.body);
    const usdAmount = SOLIDARITY_RATES[body.tier];
    if (!usdAmount) return res.status(400).json({ error: 'Invalid tier' });

    const libreAmount = BigInt(Math.round(usdAmount * USD_TO_LIBRE));

    const gift = await prisma.solidarityGift.create({
      data: {
        fromname:    body.fromName,
        fromemail:   body.fromEmail,
        targettype:  body.targetType as any,
        touserid:    body.toUserId,
        toprovince:  body.toProvince,
        libreamount: libreAmount,
        usdamount:   usdAmount,
        message:     body.message,
        anonymous:   body.anonymous,
        status:      'PENDING',
      },
    });

    const successUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/solidarity/success?gift=${gift.id}`;
    const cancelUrl  = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/solidarity`;

    const awResponse = await fetch('https://api.airwallex.com/api/v1/pa/payment_links/create', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.AIRWALLEX_API_KEY    ?? '',
        'x-client-id':  process.env.AIRWALLEX_CLIENT_ID  ?? '',
      },
      body: JSON.stringify({
        amount:       usdAmount,
        currency:     'USD',
        order:        { products: [{ name: `Cuba Libre Solidarity — ${body.tier}`, quantity: 1, unit_price: usdAmount, currency: 'USD' }] },
        success_url:  successUrl,
        cancel_url:   cancelUrl,
        metadata:     { giftId: gift.id },
      }),
    });

    if (!awResponse.ok) {
      const err = await awResponse.text();
      return res.status(502).json({ error: `Airwallex error: ${err}` });
    }

    const awData = await awResponse.json() as any;

    await prisma.solidarityGift.update({
      where: { id: gift.id },
      data:  { stripepaymentid: awData.id ?? awData.payment_link_id },
    });

    res.json({ url: awData.url ?? awData.payment_link_url, giftId: gift.id });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /history — authenticated ────────────────────────────────────────────

router.get('/history', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const gifts = await prisma.solidarityGift.findMany({
      where:   { touserid: req.user!.id },
      take:    20,
      orderBy: { createdat: 'desc' },
    });

    res.json(gifts.map(g => ({ ...g, libreamount: g.libreamount.toString() })));
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
