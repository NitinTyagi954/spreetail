import express from 'express';
import multer from 'multer';
import { prisma } from '../db.js';
import { auth } from '../middleware/auth.js';
import { parseCSV, normalizeName } from '../utils/csvParser.js';
import { detectAnomalies } from '../utils/importerEngine.js';
import { calculateSplits } from '../utils/splits.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Apply auth middleware to all imports routes
router.use(auth);

// Helper to fetch live USD/INR exchange rate
async function getExchangeRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (res.ok) {
      const data = await res.json();
      if (data.rates && data.rates.INR) {
        return data.rates.INR;
      }
    }
  } catch (err) {
    console.error('Error fetching exchange rate, using default:', err);
  }
  return 83.0; // fallback default
}

// 1. POST /api/imports/upload
// Parses uploaded CSV, runs anomaly detectors, saves session & anomalies
router.post('/upload', upload.single('file'), async (req, res) => {
  const { groupId } = req.body;

  if (!groupId) {
    return res.status(400).json({ error: 'Group ID is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file upload is required' });
  }

  try {
    // Verify user is member of the group
    const membership = await prisma.groupMembership.findFirst({
      where: { groupId, userId: req.user.id }
    });

    if (!membership) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    // Read CSV contents and parse
    const csvContent = req.file.buffer.toString('utf8');
    const parsedRows = parseCSV(csvContent);

    // Fetch all group members (active and past)
    const groupMemberships = await prisma.groupMembership.findMany({
      where: { groupId },
      include: {
        user: {
          select: { id: true, name: true, email: true, isGuest: true }
        }
      }
    });

    // Run anomaly detection
    const detected = detectAnomalies(parsedRows, groupMemberships);

    // Fetch default exchange rate
    const usdRate = await getExchangeRate();

    // Create session and anomalies in database
    const session = await prisma.$transaction(async (tx) => {
      const newSession = await tx.importSession.create({
        data: {
          groupId,
          fileName: req.file.originalname,
          status: 'IN_REVIEW',
          totalRows: parsedRows.length,
          flagged: detected.length,
          imported: 0,
          skipped: 0
        }
      });

      if (detected.length > 0) {
        const anomaliesData = detected.map((anom) => ({
          importSessionId: newSession.id,
          rowNumber: anom.rowNumber,
          anomalyType: anom.anomalyType,
          description: anom.description,
          rawData: anom.rawData,
          suggestedAction: anom.suggestedAction,
          status: 'PENDING'
        }));

        await tx.importAnomaly.createMany({
          data: anomaliesData
        });
      }

      return await tx.importSession.findUnique({
        where: { id: newSession.id },
        include: { anomalies: true }
      });
    });

    return res.status(201).json({
      session,
      exchangeRate: usdRate,
      rows: parsedRows
    });
  } catch (error) {
    console.error('CSV Import upload error:', error);
    return res.status(500).json({ error: 'Failed to process CSV file upload' });
  }
});

// 2. POST /api/imports/anomalies/:id/resolve
// Records user decision on how to resolve a flagged row
router.post('/anomalies/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { status, resolvedAction } = req.body; // status: APPROVED, REJECTED, MODIFIED

  if (!status || !['APPROVED', 'REJECTED', 'MODIFIED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid or missing resolution status' });
  }

  try {
    const anomaly = await prisma.importAnomaly.findUnique({
      where: { id },
      include: {
        importSession: true
      }
    });

    if (!anomaly) {
      return res.status(404).json({ error: 'Anomaly not found' });
    }

    // Verify user membership in group
    const membership = await prisma.groupMembership.findFirst({
      where: { groupId: anomaly.importSession.groupId, userId: req.user.id }
    });

    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedAnomaly = await prisma.importAnomaly.update({
      where: { id },
      data: {
        status,
        resolvedAction: resolvedAction ? JSON.stringify(resolvedAction) : null
      }
    });

    return res.json(updatedAnomaly);
  } catch (error) {
    console.error('Resolve anomaly error:', error);
    return res.status(500).json({ error: 'Failed to resolve anomaly' });
  }
});

// 3. POST /api/imports/finalize
// Processes the list of resolved/final rows and imports them inside a single Prisma transaction
router.post('/finalize', async (req, res) => {
  const { importSessionId, resolvedRows } = req.body;

  if (!importSessionId || !resolvedRows || !Array.isArray(resolvedRows)) {
    return res.status(400).json({ error: 'Missing importSessionId or resolvedRows array' });
  }

  try {
    const session = await prisma.importSession.findUnique({
      where: { id: importSessionId }
    });

    if (!session) {
      return res.status(404).json({ error: 'Import session not found' });
    }

    if (session.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Import session is already finalized and completed' });
    }

    const groupId = session.groupId;

    // Verify user is member of the group
    const membership = await prisma.groupMembership.findFirst({
      where: { groupId, userId: req.user.id }
    });

    if (!membership) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Commit everything in a single transaction
    const finalStats = await prisma.$transaction(async (tx) => {
      // 1. Fetch current memberships in group to resolve names
      const groupMemberships = await tx.groupMembership.findMany({
        where: { groupId },
        include: { user: true }
      });

      const memberMap = new Map(); // normalizedName -> userId
      groupMemberships.forEach(m => {
        memberMap.set(normalizeName(m.user.name).toLowerCase(), m.userId);
      });

      // Helper function to resolve a user by name, creating a guest if not found
      const resolveUserByName = async (rawName, dateForGuest) => {
        const norm = normalizeName(rawName);
        const key = norm.toLowerCase();
        if (memberMap.has(key)) {
          return memberMap.get(key);
        }

        // If not found in group, check if user exists globally by name
        let user = await tx.user.findFirst({
          where: { name: { equals: norm, mode: 'insensitive' } }
        });

        // If no user exists, create a guest user
        if (!user) {
          user = await tx.user.create({
            data: {
              name: norm,
              email: `guest-${norm.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}@spreetree.local`,
              passwordHash: '',
              isGuest: true
            }
          });
        }

        // Add guest as a member of this group
        const guestJoinDate = dateForGuest ? new Date(dateForGuest) : new Date('2026-02-01T00:00:00.000Z');
        
        await tx.groupMembership.create({
          data: {
            groupId,
            userId: user.id,
            joinedAt: guestJoinDate
          }
        });

        memberMap.set(key, user.id);
        return user.id;
      };

      // --- OPTIMIZATION: Resolve all unique names first ---
      const uniqueNames = new Set();
      for (const row of resolvedRows) {
        if (row.isSkipped || row.action === 'SKIP_ROW') continue;
        
        const paidBy = row.paidBy || row.paidByRaw;
        if (paidBy) uniqueNames.add(normalizeName(paidBy));

        const participantNames = Array.isArray(row.splitWith)
          ? row.splitWith
          : (row.splitWithRaw ? row.splitWithRaw.split(';').map(n => n.trim()).filter(Boolean) : []);
        
        participantNames.forEach(n => uniqueNames.add(normalizeName(n)));
      }

      // Resolve them sequentially to prevent race conditions
      for (const name of uniqueNames) {
        await resolveUserByName(name);
      }
      // ----------------------------------------------------

      let importedCount = 0;
      let skippedCount = 0;

      // Import rows sequentially to avoid transaction lockup / connection pool starvation in Prisma
      for (const row of resolvedRows) {
        if (row.isSkipped || row.action === 'SKIP_ROW') {
          skippedCount++;
          continue;
        }

        const expenseDate = new Date(row.date);
        const paidById = memberMap.get(normalizeName(row.paidBy || row.paidByRaw).toLowerCase());

        if (!paidById) {
          throw new Error(`Payer ${row.paidBy || row.paidByRaw} could not be resolved.`);
        }

        if (row.isSettlement || row.action === 'CONVERT_TO_SETTLEMENT') {
          // Import as Settlement
          const receiverName = (row.splitWith && row.splitWith[0]) || row.splitWithRaw;
          if (!receiverName) {
            throw new Error(`Settlement on row ${row.rowNumber} is missing a receiver.`);
          }
          const receivedById = memberMap.get(normalizeName(receiverName).toLowerCase());
          if (!receivedById) {
            throw new Error(`Receiver ${receiverName} could not be resolved.`);
          }

          await tx.settlement.create({
            data: {
              groupId,
              paidById,
              receivedById,
              amount: row.amount,
              currency: row.currency || 'INR',
              date: expenseDate,
              notes: row.notes || null,
              importSessionId
            }
          });
          importedCount++;
        } else {
          // Import as Expense
          const currency = row.currency || 'INR';
          const exchangeRate = row.exchangeRate || 1.0;
          const amountInINR = Math.round(row.amount * exchangeRate * 100) / 100;

          const participantNames = Array.isArray(row.splitWith)
            ? row.splitWith
            : (row.splitWithRaw ? row.splitWithRaw.split(';').map(n => n.trim()).filter(Boolean) : []);

          if (participantNames.length === 0) {
            throw new Error(`Expense on row ${row.rowNumber} (${row.description}) has no split participants.`);
          }

          const resolvedParticipants = participantNames.map(name => {
            const pId = memberMap.get(normalizeName(name).toLowerCase());
            if (!pId) throw new Error(`Participant ${name} could not be resolved.`);
            return pId;
          });

          // Calculate Splits
          let splitType = row.splitType || 'EQUAL';
          let splitsInput = [];

          if (splitType === 'EQUAL') {
            splitsInput = resolvedParticipants;
          } else {
            const detailParts = row.splitDetails
              ? row.splitDetails.split(/[;,]/).map(p => p.trim()).filter(Boolean)
              : [];
            
            splitsInput = [];
            for (const part of detailParts) {
              const match = part.match(/^(.+?)\s+([\d\.]+)(%?)$/);
              if (match) {
                const name = match[1];
                const value = parseFloat(match[2]);
                const pId = memberMap.get(normalizeName(name).toLowerCase());
                if (splitType === 'PERCENTAGE') {
                  splitsInput.push({ userId: pId, percentage: value });
                } else if (splitType === 'SHARE') {
                  splitsInput.push({ userId: pId, shares: Math.round(value) });
                } else {
                  splitsInput.push({ userId: pId, amount: value });
                }
              }
            }
          }

          const calculatedSplits = calculateSplits(row.amount, splitType, splitsInput);

          // Create Expense
          const expense = await tx.expense.create({
            data: {
              groupId,
              description: row.description.trim(),
              amount: row.amount,
              currency,
              amountInINR,
              exchangeRate,
              date: expenseDate,
              paidById,
              splitType,
              notes: row.notes || null,
              isRefund: row.isRefund || false,
              importSessionId
            }
          });

          // Create splits in database
          const splitsData = calculatedSplits.map(s => ({
            expenseId: expense.id,
            userId: s.userId,
            amount: s.amount,
            percentage: s.percentage || null,
            shares: s.shares || null
          }));

          await tx.expenseSplit.createMany({
            data: splitsData
          });

          importedCount++;
        }
      }

      // 2. Update ImportSession status
      const updatedSession = await tx.importSession.update({
        where: { id: importSessionId },
        data: {
          status: 'COMPLETED',
          imported: importedCount,
          skipped: skippedCount
        }
      });

      // 3. Mark all anomalies under this session as resolved
      await tx.importAnomaly.updateMany({
        where: { importSessionId },
        data: {
          status: 'APPROVED'
        }
      });

      return updatedSession;
    }, {
      maxWait: 30000,
      timeout: 90000
    });

    return res.json({
      message: 'Import session completed and saved successfully.',
      session: finalStats
    });
  } catch (error) {
    console.error('Finalize import error:', error);
    return res.status(500).json({ error: `Failed to finalize import session: ${error.message}` });
  }
});

export default router;
