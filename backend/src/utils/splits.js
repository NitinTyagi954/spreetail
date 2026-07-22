/**
 * Calculates expense split amounts for participants using integer arithmetic (paise/cents).
 * Avoids floating-point precision issues by conducting all calculations in the smallest currency unit.
 * 
 * @param {number} totalAmount - The total expense amount to split (in original currency decimal format)
 * @param {'EQUAL'|'UNEQUAL'|'PERCENTAGE'|'SHARE'} splitType - The method of splitting
 * @param {Array<string|Object>} participants - Array of participant data
 * 
 * @returns {Array<Object>} Array of splits: [{ userId: 'id1', amount: 25.00, percentage?: number, shares?: number }]
 */
export function calculateSplits(totalAmount, splitType, participants) {
  if (totalAmount <= 0) {
    throw new Error('Total amount must be greater than zero');
  }
  if (!participants || participants.length === 0) {
    throw new Error('Participants list cannot be empty');
  }

  // Convert total decimal amount to integer smallest currency unit (paise/cents)
  const totalPaise = Math.round(totalAmount * 100);
  let splits = [];

  switch (splitType) {
    case 'EQUAL': {
      const count = participants.length;
      const basePaise = Math.floor(totalPaise / count);
      
      splits = participants.map((userId) => {
        if (typeof userId !== 'string') {
          throw new Error('For EQUAL splits, participants must be user ID strings');
        }
        return {
          userId,
          amountPaise: basePaise,
          percentage: Math.round((100 / count) * 100) / 100,
          shares: 1,
        };
      });
      break;
    }

    case 'UNEQUAL': {
      let sumPaise = 0;
      splits = participants.map((p) => {
        if (!p.userId || typeof p.amount !== 'number') {
          throw new Error('For UNEQUAL splits, participants must contain userId and numeric amount');
        }
        const amtPaise = Math.round(p.amount * 100);
        sumPaise += amtPaise;
        return {
          userId: p.userId,
          amountPaise: amtPaise,
        };
      });

      if (sumPaise !== totalPaise) {
        throw new Error(`Sum of unequal split amounts (${sumPaise / 100}) must equal total expense amount (${totalPaise / 100})`);
      }
      break;
    }

    case 'PERCENTAGE': {
      let percentSum = 0;
      splits = participants.map((p) => {
        if (!p.userId || typeof p.percentage !== 'number') {
          throw new Error('For PERCENTAGE splits, participants must contain userId and numeric percentage');
        }
        percentSum += p.percentage;
        
        const amtPaise = Math.floor((p.percentage / 100) * totalPaise);
        return {
          userId: p.userId,
          amountPaise: amtPaise,
          percentage: p.percentage,
        };
      });

      const roundedPercentSum = Math.round(percentSum * 100) / 100;
      const diff = Math.round(Math.abs(roundedPercentSum - 100) * 100) / 100;
      if (diff > 0.01) {
        throw new Error(`Sum of percentages must equal 100%, got ${roundedPercentSum}%`);
      }
      break;
    }

    case 'SHARE': {
      let totalShares = 0;
      participants.forEach((p) => {
        if (!p.userId || typeof p.shares !== 'number' || p.shares < 0) {
          throw new Error('For SHARE splits, participants must contain userId and non-negative shares');
        }
        totalShares += p.shares;
      });

      if (totalShares <= 0) {
        throw new Error('Total shares must be greater than zero');
      }

      splits = participants.map((p) => {
        const amtPaise = Math.floor((p.shares / totalShares) * totalPaise);
        return {
          userId: p.userId,
          amountPaise: amtPaise,
          shares: p.shares,
          percentage: Math.round(((p.shares / totalShares) * 100) * 100) / 100,
        };
      });
      break;
    }

    default:
      throw new Error(`Invalid split type: ${splitType}`);
  }

  // Adjust for remaining paise from integer floor division
  const allocatedSumPaise = splits.reduce((sum, s) => sum + s.amountPaise, 0);
  const remainderPaise = totalPaise - allocatedSumPaise;

  if (remainderPaise !== 0 && splits.length > 0) {
    let maxIndex = 0;
    for (let i = 1; i < splits.length; i++) {
      if (splits[i].amountPaise > splits[maxIndex].amountPaise) {
        maxIndex = i;
      }
    }
    splits[maxIndex].amountPaise += remainderPaise;
  }

  // Convert integer paise back to decimal format for output
  return splits.map((s) => {
    const { amountPaise, ...rest } = s;
    return {
      ...rest,
      amount: amountPaise / 100,
    };
  });
}