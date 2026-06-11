import { qs, qsr, qsn } from '../utils/query';
/**
 * libre.ts — Libre currency system for Cuba Libre
 * Handles balance queries, transaction history, daily claims, transfers,
 * leaderboard, stats, bug reports, and earn guide.
 * All mutations are atomic (prisma.$transaction).
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { LIBRE_EARN } from '../config';

const router = Router();

// ─── Helper: creditLibre ──────────────────────────────────────────────────────

export async function creditLibre(
  userId: string,
  amount: bigint,
  type: string,
  description: string,
  referenceId?: string,
) {
  return prisma.$transaction(async (tx) => {
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

    const tx2 = await tx.libreTransaction.create({
      data: {
        walletid:     wallet.id,
        amount,
        type:         type as any,
        description,
        referenceid:  referenceId,
        balanceafter: wallet.balance,
      },
    });

    return { wallet, transaction: tx2 };
  });
}

// ─── GET /libre/balance ───────────────────────────────────────────────────────

router.get('/balance', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const wallet = await prisma.libreWallet.upsert({
      where:  { userid: req.user!.id },
      update: {},
      create: { userid: req.user!.id, balance: 0n, lifetimeearned: 0n },
    });

    res.json({
      balance:        wallet.balance.toString(),
      lifetimeearned: wallet.lifetimeearned.toString(),
      lifetimespent:  wallet.lifetimespent.toString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /libre/transactions ──────────────────────────────────────────────────

router.get('/transactions', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const wallet = await prisma.libreWallet.findUnique({ where: { userid: req.user!.id } });
    if (!wallet) return res.json({ transactions: [], total: 0 });

    const [transactions, total] = await Promise.all([
      prisma.libreTransaction.findMany({
        where:   { walletid: wallet.id },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
      }),
      prisma.libreTransaction.count({ where: { walletid: wallet.id } }),
    ]);

    res.json({
      transactions: transactions.map(t => ({
        ...t,
        amount:       t.amount.toString(),
        balanceafter: t.balanceafter.toString(),
      })),
      total,
      page: parseInt(page),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /libre/earn/daily ───────────────────────────────────────────────────

router.post('/earn/daily', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const wallet = await prisma.libreWallet.findUnique({ where: { userid: req.user!.id } });

    if (wallet) {
      const lastDaily = await prisma.libreTransaction.findFirst({
        where:   { walletid: wallet.id, type: 'EARN_DAILY' },
        orderBy: { createdat: 'desc' },
      });

      if (lastDaily) {
        const msAgo = Date.now() - lastDaily.createdat.getTime();
        if (msAgo < 24 * 60 * 60 * 1000) {
          const nextClaimMs = 24 * 60 * 60 * 1000 - msAgo;
          return res.status(429).json({
            error:        'Daily claim already used. Come back tomorrow!',
            nextClaimIn:  Math.ceil(nextClaimMs / 1000 / 60) + ' minutes',
          });
        }
      }
    }

    const amount = BigInt(LIBRE_EARN.DAILY);
    const result = await creditLibre(req.user!.id, amount, 'EARN_DAILY', '¡Buen día! Daily Libre claim');
    res.json({ earned: amount.toString(), balance: result.wallet.balance.toString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /libre/transfer ─────────────────────────────────────────────────────

const TransferSchema = z.object({
  toUserId:    z.string().uuid(),
  amount:      z.number().int().positive(),
  description: z.string().optional(),
});

router.post('/transfer', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body   = TransferSchema.parse(req.body);
    const amount = BigInt(body.amount);

    if (body.toUserId === req.user!.id) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    const toUser = await prisma.user.findUnique({ where: { id: body.toUserId } });
    if (!toUser) return res.status(404).json({ error: 'Recipient not found' });

    await prisma.$transaction(async (tx) => {
      const fromWallet = await tx.libreWallet.findUnique({ where: { userid: req.user!.id } });
      if (!fromWallet || fromWallet.balance < amount) {
        throw new Error('Saldo de Libre insuficiente');
      }

      const updatedFrom = await tx.libreWallet.update({
        where: { userid: req.user!.id },
        data:  { balance: { decrement: amount }, lifetimespent: { increment: amount } },
      });

      const toWallet = await tx.libreWallet.upsert({
        where:  { userid: body.toUserId },
        update: { balance: { increment: amount }, lifetimeearned: { increment: amount } },
        create: { userid: body.toUserId, balance: amount, lifetimeearned: amount },
      });

      await tx.libreTransaction.create({
        data: {
          walletid:      fromWallet.id,
          amount:        -amount,
          type:          'TRANSFER',
          description:   body.description ?? `Transfer to ${toUser.name}`,
          towalletid:    toWallet.id,
          balanceafter:  updatedFrom.balance,
        },
      });

      await tx.libreTransaction.create({
        data: {
          walletid:      toWallet.id,
          amount,
          type:          'TRANSFER',
          description:   body.description ?? `Transfer from user`,
          fromwalletid:  fromWallet.id,
          balanceafter:  toWallet.balance,
        },
      });
    });

    res.json({ success: true, transferred: amount.toString() });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    if (err.message.includes('insuficiente')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /libre/leaderboard ───────────────────────────────────────────────────

router.get('/leaderboard', async (_req, res) => {
  try {
    const wallets = await prisma.libreWallet.findMany({
      orderBy: { lifetimeearned: 'desc' },
      take:    20,
      include: { user: { select: { id: true, name: true, avatarurl: true, province: true } } },
    });

    res.json(wallets.map((w, i) => ({
      rank:          i + 1,
      userId:        w.user.id,
      name:          w.user.name,
      avatarurl:     w.user.avatarurl,
      province:      w.user.province,
      lifetimeearned: w.lifetimeearned.toString(),
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /libre/stats ─────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
  try {
    const [wallets, totalResult] = await Promise.all([
      prisma.libreWallet.count(),
      prisma.libreWallet.aggregate({ _sum: { balance: true } }),
    ]);

    res.json({
      totalWallets:      wallets,
      totalInCirculation: (totalResult._sum.balance ?? 0n).toString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /libre/earn/bug ─────────────────────────────────────────────────────

const BugSchema = z.object({
  title:       z.string().min(5),
  description: z.string().min(20),
  severity:    z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  url:         z.string().optional(),
  steps:       z.string().optional(),
});

router.post('/earn/bug', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = BugSchema.parse(req.body);

    // Throttle: 3 bug reports per day
    const wallet = await prisma.libreWallet.findUnique({ where: { userid: req.user!.id } });
    if (wallet) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const todayBugs = await prisma.libreTransaction.count({
        where: {
          walletid:  wallet.id,
          type:      'EARN_BUG',
          createdat: { gte: since },
        },
      });
      if (todayBugs >= 3) {
        return res.status(429).json({ error: 'Max 3 bug reports per day' });
      }
    }

    const amount = BigInt(LIBRE_EARN.BUG);
    const result = await creditLibre(
      req.user!.id,
      amount,
      'EARN_BUG',
      `Bug report: ${body.title}`,
    );

    res.status(201).json({
      earned:  amount.toString(),
      balance: result.wallet.balance.toString(),
      message: '¡Gracias! Bug report received. You earned ' + amount + ' Libre.',
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /libre/earn-guide ────────────────────────────────────────────────────

router.get('/earn-guide', (_req, res) => {
  res.json({
    actions: [
      { action: 'Sign up',           libre: LIBRE_EARN.SIGNUP,    type: 'EARN_SIGNUP',    frequency: 'once' },
      { action: 'Daily check-in',    libre: LIBRE_EARN.DAILY,     type: 'EARN_DAILY',     frequency: 'daily' },
      { action: 'Submit listing',    libre: LIBRE_EARN.LISTING,   type: 'EARN_LISTING',   frequency: 'per listing' },
      { action: 'Write a review',    libre: LIBRE_EARN.REVIEW,    type: 'EARN_REVIEW',    frequency: 'per review' },
      { action: 'Translation approved', libre: LIBRE_EARN.TRANSLATE, type: 'EARN_TRANSLATE', frequency: 'per approval' },
      { action: 'Report a bug',      libre: LIBRE_EARN.BUG,       type: 'EARN_BUG',       frequency: 'up to 3/day' },
      { action: 'Refer a friend',    libre: LIBRE_EARN.REFERRAL,  type: 'EARN_REFERRAL',  frequency: 'per referral' },
      { action: 'Contribute code',   libre: LIBRE_EARN.CODE,      type: 'EARN_CODE',      frequency: 'per merge' },
    ],
  });
});

export default router;
