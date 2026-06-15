import { prisma } from './src/db.js';

async function test() {
  const groupId = '3308ad7f-4647-489e-8a24-fbbc74a0d7ce';
  console.log('Fetching memberships...');
  const memberships = await prisma.groupMembership.findMany({
    where: { groupId },
    include: {
      user: {
        select: { id: true, name: true, email: true, isGuest: true }
      }
    }
  });

  const userBalances = {};
  memberships.forEach((m) => {
    userBalances[m.user.id] = {
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      isGuest: m.user.isGuest,
      totalPaid: 0.0,
      totalOwed: 0.0,
      totalSentSettlements: 0.0,
      totalReceivedSettlements: 0.0,
      netBalance: 0.0,
      ledger: [],
    };
  });

  console.log('Fetching expenses...');
  const expenses = await prisma.expense.findMany({
    where: { groupId },
    include: { splits: true }
  });

  console.log('Fetching settlements...');
  const settlements = await prisma.settlement.findMany({
    where: { groupId }
  });

  console.log('Aggregating expenses...');
  expenses.forEach((expense) => {
    const sign = expense.isRefund ? -1 : 1;
    const amountInINR = expense.amountInINR;
    if (userBalances[expense.paidById]) {
      userBalances[expense.paidById].totalPaid += sign * amountInINR;
    }
    expense.splits.forEach((split) => {
      if (userBalances[split.userId]) {
        const splitAmountInINR = split.amount * expense.exchangeRate;
        userBalances[split.userId].totalOwed += sign * splitAmountInINR;
      }
    });
  });

  console.log('Aggregating settlements...');
  settlements.forEach((settlement) => {
    if (userBalances[settlement.paidById]) {
      userBalances[settlement.paidById].totalSentSettlements += settlement.amount;
    }
    if (userBalances[settlement.receivedById]) {
      userBalances[settlement.receivedById].totalReceivedSettlements += settlement.amount;
    }
  });

  const debtorBalances = [];
  const creditorBalances = [];

  Object.keys(userBalances).forEach((userId) => {
    const u = userBalances[userId];
    u.totalPaid = Math.round(u.totalPaid * 100) / 100;
    u.totalOwed = Math.round(u.totalOwed * 100) / 100;
    u.totalSentSettlements = Math.round(u.totalSentSettlements * 100) / 100;
    u.totalReceivedSettlements = Math.round(u.totalReceivedSettlements * 100) / 100;
    
    const net = (u.totalPaid - u.totalOwed) + u.totalSentSettlements - u.totalReceivedSettlements;
    u.netBalance = Math.round(net * 100) / 100;

    if (u.netBalance < -0.01) {
      debtorBalances.push({ userId: u.userId, name: u.name, balance: u.netBalance });
    } else if (u.netBalance > 0.01) {
      creditorBalances.push({ userId: u.userId, name: u.name, balance: u.netBalance });
    }
  });

  console.log('Initial Debtor Balances:', debtorBalances);
  console.log('Initial Creditor Balances:', creditorBalances);

  console.log('Running Debt Simplification Loop...');
  const suggestedSettlements = [];
  let dIdx = 0;
  let cIdx = 0;
  let iterations = 0;

  while (dIdx < debtorBalances.length && cIdx < creditorBalances.length) {
    iterations++;
    if (iterations > 100) {
      console.error('INFINITE LOOP DETECTED!');
      console.log('dIdx:', dIdx, 'cIdx:', cIdx);
      console.log('Current Debtor:', debtorBalances[dIdx]);
      console.log('Current Creditor:', creditorBalances[cIdx]);
      break;
    }

    const debtor = debtorBalances[dIdx];
    const creditor = creditorBalances[cIdx];

    const amountToPay = Math.min(-debtor.balance, creditor.balance);
    const roundedAmount = Math.round(amountToPay * 100) / 100;

    console.log(`Iteration ${iterations}: ${debtor.name} (${debtor.balance}) pays ${creditor.name} (${creditor.balance}), amountToPay=${amountToPay}, roundedAmount=${roundedAmount}`);

    if (roundedAmount > 0.01) {
      suggestedSettlements.push({
        from: debtor.userId,
        fromName: debtor.name,
        to: creditor.userId,
        toName: creditor.name,
        amount: roundedAmount,
      });
    }

    debtor.balance += roundedAmount;
    creditor.balance -= roundedAmount;

    if (Math.abs(debtor.balance) < 0.01) {
      dIdx++;
    }
    if (Math.abs(creditor.balance) < 0.01) {
      cIdx++;
    }
  }

  console.log('Finished! Suggested settlements:', suggestedSettlements);
  process.exit(0);
}

test();
