import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  max: 3, // Prevent pool starvation on Neon
  idleTimeoutMillis: 10000, // Close idle connections after 10s
  connectionTimeoutMillis: 5000 // Timeout fast if connection fails
});

const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });
