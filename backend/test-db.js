import { prisma } from './src/db.js';

async function test() {
  console.log('Querying groupMembership with include...');
  try {
    const memberships = await prisma.groupMembership.findMany({
      where: {
        userId: '5fd670a0-0615-4581-a024-a628462d5c50',
      },
      include: {
        group: true,
      },
    });
    console.log('Success! Memberships with group found:', memberships);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

test();
