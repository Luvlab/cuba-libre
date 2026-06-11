import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port:        process.env.PORT        || 3001,
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret:   process.env.JWT_SECRET   || 'cuba-libre-change-in-prod',
  nodeEnv:     process.env.NODE_ENV     || 'development',
  corsOrigin:  process.env.CORS_ORIGIN  || 'http://localhost:4200',
};

// Cuba's 15 provinces
export const CUBA_PROVINCES = [
  'Pinar del Río',
  'Artemisa',
  'La Habana',
  'Mayabeque',
  'Matanzas',
  'Cienfuegos',
  'Villa Clara',
  'Sancti Spíritus',
  'Ciego de Ávila',
  'Camagüey',
  'Las Tunas',
  'Holguín',
  'Granma',
  'Santiago de Cuba',
  'Guantánamo',
  'Isla de la Juventud',
];

// Libre earning rules
export const LIBRE_EARN = {
  SIGNUP:    100,
  DAILY:      10,
  LISTING:    50,
  REVIEW:     25,
  TRANSLATE: 100,
  BUG:       200,
  REFERRAL:  500,
  CODE:     1000,
};

// Solidarity conversion rate: $1 USD = 100 Libre
export const USD_TO_LIBRE = 100;
