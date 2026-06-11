import { qs, qsr, qsn } from '../utils/query';
/**
 * ai.ts — AI assistant routes for Cuba Libre
 * Provides a streaming chat endpoint (SSE) and a structured search endpoint.
 * Uses Anthropic Claude as primary, OpenRouter as fallback.
 * The assistant knows about Cuba's 15 provinces and the Libre currency.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';

const router = Router();

const SYSTEM_PROMPT = `You are a helpful assistant for Cuba Libre, a free open-source community platform for Cuba and the Cuban diaspora. You speak Spanish primarily but also English. You help with finding businesses, services, events across Cuba's 15 provinces: ${CUBA_PROVINCES.join(', ')}. You know about the Libre currency system — internal credits users earn through participation, reviews, translations, and community engagement. You are warm, helpful, and proud of Cuban culture. If asked in Spanish, respond in Spanish. If asked in English, respond in English. You do not discuss politics.`;

// ─── POST /ai/chat — Streaming SSE ───────────────────────────────────────────

const ChatSchema = z.object({
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
  })).min(1),
  province: z.string().optional(),
});

router.post('/chat', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = ChatSchema.parse(req.body);

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const systemAddendum = body.province
      ? `\n\nThe user is currently browsing listings in: ${body.province}.`
      : '';

    const streamText = async () => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const stream = await client.messages.stream({
        model:      'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system:     SYSTEM_PROMPT + systemAddendum,
        messages:   body.messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    };

    streamText().catch(async (err) => {
      // Fallback to OpenRouter
      try {
        const openrouterKey = process.env.OPENROUTER_API_KEY;
        if (!openrouterKey) throw new Error('No fallback available');

        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${openrouterKey}`,
            'HTTP-Referer':  'https://cuba.libre',
          },
          body: JSON.stringify({
            model:    'mistralai/mistral-7b-instruct',
            messages: [{ role: 'system', content: SYSTEM_PROMPT + systemAddendum }, ...body.messages],
            stream:   true,
          }),
        });

        const reader = resp.body?.getReader();
        const dec    = new TextDecoder();
        if (!reader) throw new Error('No reader');

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = dec.decode(value).split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const d = JSON.parse(line.slice(6));
                const text = d.choices?.[0]?.delta?.content ?? '';
                if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
              } catch {}
            }
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
        res.write(`data: ${JSON.stringify({ error: 'AI temporarily unavailable' })}\n\n`);
        res.end();
      }
    });

  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /ai/search — Structured listing search ─────────────────────────────

const SearchSchema = z.object({
  query:    z.string().min(2),
  province: z.string().optional(),
  limit:    z.number().int().default(10),
});

router.post('/search', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { query, province, limit } = SearchSchema.parse(req.body);

    const where: any = { active: true };
    if (province) where.province = province;
    where.OR = [
      { name:        { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { category:    { contains: query, mode: 'insensitive' } },
      { address:     { contains: query, mode: 'insensitive' } },
    ];

    const listings = await prisma.listing.findMany({
      where,
      take:    limit,
      orderBy: [{ ispro: 'desc' }, { avgrating: 'desc' }],
      include: { tags: true },
    });

    // Ask Claude to rank/summarise results
    let summary = '';
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const msg = await client.messages.create({
        model:      'claude-3-5-haiku-20241022',
        max_tokens: 512,
        system:     SYSTEM_PROMPT,
        messages: [{
          role:    'user',
          content: `The user searched for "${query}"${province ? ` in ${province}` : ''}. Here are the top results: ${listings.slice(0, 5).map(l => `${l.name} (${l.category ?? 'general'}, ${l.province})`).join(', ')}. Write a 1-2 sentence helpful response in the user's language.`,
        }],
      });

      summary = (msg.content[0] as any).text ?? '';
    } catch {}

    res.json({ listings, summary, total: listings.length });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
