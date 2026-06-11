/**
 * Cuba Libre API v1
 * Open-source community backend for cuba.red
 * MIT License — for the Cuban people 🇨🇺
 */
import express from 'express';
import cors    from 'cors';
import helmet  from 'helmet';
import morgan  from 'morgan';

import { config } from './config';

import authRouter          from './routes/auth';
import listingsRouter      from './routes/listings';
import reviewsRouter       from './routes/reviews';
import bookingsRouter      from './routes/bookings';
import eventsRouter        from './routes/events';
import eventDiscoverRouter from './routes/eventDiscover';
import newsRouter          from './routes/news';
import classifiedsRouter   from './routes/classifieds';
import pricesRouter        from './routes/prices';
import radioRouter         from './routes/radio';
import ridesRouter         from './routes/rides';
import marketRouter        from './routes/market';
import translationsRouter  from './routes/translations';
import followsRouter       from './routes/follows';
import messagesRouter      from './routes/messages';
import analyticsRouter     from './routes/analytics';
import aiRouter            from './routes/ai';
import adsRouter           from './routes/ads';
import ambassadorRouter    from './routes/ambassador';
import paymentsRouter      from './routes/payments';
import libreRouter         from './routes/libre';
import solidarityRouter    from './routes/solidarity';
import certificationsRouter from './routes/certifications';
import groupsRouter        from './routes/groups';
import adminRouter         from './routes/admin';
import uploadRouter        from './routes/upload';
import geoRouter           from './routes/geo';
import salesrepsRouter     from './routes/salesreps';
import promotionsRouter    from './routes/promotions';
import feedbackRouter      from './routes/feedback';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = (config.corsOrigin)
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      allowedOrigins.some(o => origin === o) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.cuba.red') ||
      origin === 'https://cuba.red' ||
      origin === 'https://www.cuba.red'
    ) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));

app.use(morgan('dev'));

// Raw body for Stripe webhook signature verification
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/',       (_req, res) => res.redirect('/health'));
app.get('/health', (_req, res) => res.json({
  status:  'ok',
  version: '1.0.0',
  app:     'Cuba Libre API',
  mission: 'Free, open-source community platform for the Cuban people 🇨🇺',
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/listings',      listingsRouter);
app.use('/api/reviews',       reviewsRouter);
app.use('/api/bookings',      bookingsRouter);
app.use('/api/events',        eventsRouter);
app.use('/api/events',        eventDiscoverRouter);
app.use('/api/news',          newsRouter);
app.use('/api/classifieds',   classifiedsRouter);
app.use('/api/prices',        pricesRouter);
app.use('/api/radio',         radioRouter);
app.use('/api/rides',         ridesRouter);
app.use('/api/market',        marketRouter);
app.use('/api/translations',  translationsRouter);
app.use('/api/follows',       followsRouter);
app.use('/api/messages',      messagesRouter);
app.use('/api/analytics',     analyticsRouter);
app.use('/api/ai',            aiRouter);
app.use('/api/ads',           adsRouter);
app.use('/api/ambassador',    ambassadorRouter);
app.use('/api/payments',      paymentsRouter);
app.use('/api/libre',         libreRouter);
app.use('/api/solidarity',    solidarityRouter);
app.use('/api/certifications', certificationsRouter);
app.use('/api/groups',        groupsRouter);
app.use('/api/admin',         adminRouter);
app.use('/api/upload',        uploadRouter);
app.use('/api/geo',           geoRouter);
app.use('/api/salesreps',     salesrepsRouter);
app.use('/api/promotions',    promotionsRouter);
app.use('/api/feedback',      feedbackRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Only start HTTP server when running locally (not on Vercel serverless)
if (process.env.VERCEL !== '1') {
  app.listen(config.port, () => {
    console.log(`🇨🇺 Cuba Libre API running on port ${config.port}`);
  });
}

export default app;
