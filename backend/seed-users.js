import { prisma } from './src/db.js';
import bcrypt from 'bcryptjs';

async function seed() {
  console.log('Seeding user accounts...');
  const users = [
    { name: 'Aisha', email: 'aisha@gmail.com' },
    { name: 'Rohan', email: 'rohan@gmail.com' },
    { name: 'Priya', email: 'priya@gmail.com' },
    { name: 'Meera', email: 'meera@gmail.com' },
    { name: 'Dev', email: 'dev@gmail.com' },
    { name: 'Sam', email: 'sam@gmail.com' }
  ];

  const password = 'password123';
  const passwordHash = await bcrypt.hash(password, 10);

  for (const u of users) {
    try {
      const existing = await prisma.user.findUnique({
        where: { email: u.email }
      });

      if (existing) {
        console.log(`User ${u.name} (${u.email}) already exists.`);
        // Update password hash just in case
        await prisma.user.update({
          where: { email: u.email },
          data: { passwordHash, isGuest: false }
        });
        console.log(`Updated password for ${u.name}.`);
      } else {
        const newUser = await prisma.user.create({
          data: {
            name: u.name,
            email: u.email,
            passwordHash,
            isGuest: false
          }
        });
        console.log(`Created user ${newUser.name} with ID: ${newUser.id}`);
      }
    } catch (err) {
      console.error(`Error processing user ${u.name}:`, err);
    }
  }

  console.log('User seeding completed successfully!');
  process.exit(0);
}

seed();
