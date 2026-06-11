import { qs, qsr, qsn } from '../utils/query';
/**
 * translations.ts — Crowdsourced Spanish/English translation system for Cuba Libre
 * Earns 100 Libre on approval. Voting earns 5 Libre to suggester at 10 votes.
 * Admin approves and atomically credits Libre.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { creditLibre } from './libre';

const router = Router();

const EARN_TRANSLATION = 100n;
const VOTE_MILESTONE   = 10;
const EARN_VOTE        = 5n;

// ─── Schema ───────────────────────────────────────────────────────────────────

const TranslationSchema = z.object({
  sourcetext:      z.string().min(2),
  translationtext: z.string().min(2),
  language:        z.string().default('en'),
  context:         z.string().optional(),
});

// ─── GET /translations ────────────────────────────────────────────────────────

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { language, page = '1', limit = '30' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = { approved: true };
    if (language) where.language = language;

    const [suggestions, total] = await Promise.all([
      prisma.translationSuggestion.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { votecount: 'desc' },
        include: { user: { select: { id: true, name: true, avatarurl: true } } },
      }),
      prisma.translationSuggestion.count({ where }),
    ]);

    res.json({ suggestions, total, page: parseInt(page) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /translations ───────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = TranslationSchema.parse(req.body);
    const suggestion = await prisma.translationSuggestion.create({
      data: { ...body, userid: req.user!.id },
    });
    res.status(201).json(suggestion);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /translations/:id/vote ──────────────────────────────────────────────

router.post('/:id/vote', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const suggestion = await prisma.translationSuggestion.findUnique({ where: { id: qsr(req.params.id) } });
    if (!suggestion) return res.status(404).json({ error: 'Translation not found' });

    // Idempotent: only one vote per user
    const existing = await prisma.translationVote.findUnique({
      where: { userid_suggestionid: { userid: req.user!.id, suggestionid: qsr(req.params.id) } },
    });
    if (existing) return res.status(409).json({ error: 'Already voted' });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.translationVote.create({
        data: { userid: req.user!.id, suggestionid: qsr(req.params.id) },
      });
      return tx.translationSuggestion.update({
        where: { id: qsr(req.params.id) },
        data:  { votecount: { increment: 1 } },
      });
    });

    // On vote milestone, credit suggester 5 Libre
    if (updated.votecount === VOTE_MILESTONE) {
      await creditLibre(suggestion.userid, EARN_VOTE, 'EARN_TRANSLATE', `Translation reached ${VOTE_MILESTONE} votes`, qsr(req.params.id));
    }

    res.json({ votecount: updated.votecount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /translations/:id/approve ─────────────────────────────────────────

router.patch('/:id/approve', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });

    const suggestion = await prisma.translationSuggestion.findUnique({ where: { id: qsr(req.params.id) } });
    if (!suggestion) return res.status(404).json({ error: 'Translation not found' });
    if (suggestion.approved) return res.status(409).json({ error: 'Already approved' });

    const updated = await prisma.translationSuggestion.update({
      where: { id: qsr(req.params.id) },
      data:  { approved: true },
    });

    // Credit suggester 100 Libre
    await creditLibre(suggestion.userid, EARN_TRANSLATION, 'EARN_TRANSLATE', `Translation approved: "${suggestion.sourcetext}"`, qsr(req.params.id));

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
