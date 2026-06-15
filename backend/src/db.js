import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  max: 6, // Sufficient for concurrent page requests
  idleTimeoutMillis: 30000, // Keep connections active for 30 seconds
  connectionTimeoutMillis: 10000
});

const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter, log: ['error', 'warn'] });
