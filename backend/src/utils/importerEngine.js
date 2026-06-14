import { normalizeName, parseCSVDate, parseCSVAmount } from './csvParser.js';

/**
 * Calculates the Levenshtein distance between two strings.
 */
export function getLevenshteinDistance(a, b) {
  const str1 = a.toLowerCase().trim();
  const str2 = b.toLowerCase().trim();
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) matrix[i] = [i];
  for (let j = 0; j <= str1.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

/**
 * Checks if two descriptions are similar based on word overlap.
 */
export function areDescriptionsSimilar(desc1, desc2) {
  if (!desc1 || !desc2) return false;
  const d1 = desc1.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const d2 = desc2.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (d1 === d2) return true;

  const words1 = d1.split(/\s+/).filter(w => w.length > 2);
  const words2 = d2.split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return false;
  
  const matches = words1.filter(w => words2.includes(w));
  const minLen = Math.min(words1.length, words2.length);
  return (matches.length / minLen) >= 0.7;
}

/**
 * Checks if two dates represent the same calendar day in UTC.
 */
export function areDatesSameDay(date1, date2) {
  if (!date1 || !date2) return false;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return d1.getUTCFullYear() === d2.getUTCFullYear() &&
         d1.getUTCMonth() === d2.getUTCMonth() &&
         d1.getUTCDate() === d2.getUTCDate();
}

/**
 * Parses details format such as "Aisha 30%; Rohan 30%" or "Aisha 1; Rohan 2".
 */
export function parseSplitDetails(detailsStr) {
  if (!detailsStr) return [];
  return detailsStr.split(/[;,]/).map(part => {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(.+?)\s+([\d\.]+)(%?)$/);
    if (!match) return null;
    return {
      name: normalizeName(match[1]),
      value: parseFloat(match[2]),
      isPercentage: match[3] === '%'
    };
  }).filter(Boolean);
}

/**
 * Run anomaly detection on all parsed CSV rows.
 * @param {Array<Object>} rows - Normalized CSV rows
 * @param {Array<Object>} groupMemberships - List of GroupMembership objects with User details
 * @returns {Array<Object>} List of ImportAnomaly objects
 */
export function detectAnomalies(rows, groupMemberships) {
  const anomalies = [];
  
  // Map memberships into a clean array of members with user and date limits
  const members = groupMemberships.map(m => ({
    id: m.userId || m.user.id,
    name: normalizeName(m.user.name),
    joinedAt: new Date(m.joinedAt),
    leftAt: m.leftAt ? new Date(m.leftAt) : null,
    isGuest: m.user.isGuest || false
  }));

  const findMemberByName = (name) => {
    if (!name) return null;
    const norm = normalizeName(name);
    return members.find(m => m.name.toLowerCase() === norm.toLowerCase());
  };

  const fuzzyFindMember = (name) => {
    if (!name) return null;
    const normName = normalizeName(name).toLowerCase();
    
    // First find closest name by Levenshtein distance
    let bestMatch = null;
    let minDistance = 999;
    
    for (const m of members) {
      const dist = getLevenshteinDistance(normName, m.name);
      if (dist < minDistance) {
        minDistance = dist;
        bestMatch = m;
      }
    }
    
    // If distance <= 3 or name is a prefix/suffix, suggest mapping
    if (minDistance <= 3 || normName.includes(bestMatch.name.toLowerCase()) || bestMatch.name.toLowerCase().includes(normName)) {
      return bestMatch;
    }
    return null;
  };

  // 1. Duplicate & Conflicting Duplicate detection
  // Store duplicates to avoid flagging duplicates multiple times or flagging original
  const duplicateFlags = new Set();

  for (let i = 0; i < rows.length; i++) {
    const rowA = rows[i];
    for (let j = i + 1; j < rows.length; j++) {
      const rowB = rows[j];
      
      const dateMatch = rowA.date && rowB.date ? areDatesSameDay(rowA.date, rowB.date) : (rowA.rawDate === rowB.rawDate);
      const descMatch = areDescriptionsSimilar(rowA.description, rowB.description);

      if (dateMatch && descMatch) {
        const amountMatch = rowA.amount === rowB.amount;
        const payerMatch = rowA.paidByRaw.trim().toLowerCase() === rowB.paidByRaw.trim().toLowerCase();

        if (amountMatch && payerMatch) {
          // Exact duplicate
          // Suggest keeping the one with notes or the first one
          const hasNotesA = !!rowA.notes;
          const hasNotesB = !!rowB.notes;
          let keepRow, discardRow;

          if (hasNotesA && !hasNotesB) {
            keepRow = rowA;
            discardRow = rowB;
          } else {
            keepRow = rowA;
            discardRow = rowB; // default to discarding the later one
          }

          if (!duplicateFlags.has(`exact-${discardRow.rowNumber}`)) {
            duplicateFlags.add(`exact-${discardRow.rowNumber}`);
            anomalies.push({
              rowNumber: discardRow.rowNumber,
              anomalyType: 'DUPLICATE',
              description: `Duplicate expense of Row ${keepRow.rowNumber} (${keepRow.description}).`,
              rawData: JSON.stringify(discardRow),
              suggestedAction: JSON.stringify({
                action: 'DISCARD',
                keepRowNumber: keepRow.rowNumber
              })
            });
          }
        } else {
          // Conflicting duplicate (different amount or different payer)
          if (!duplicateFlags.has(`conflict-${rowA.rowNumber}-${rowB.rowNumber}`)) {
            duplicateFlags.add(`conflict-${rowA.rowNumber}-${rowB.rowNumber}`);
            anomalies.push({
              rowNumber: rowB.rowNumber,
              anomalyType: 'DUPLICATE',
              description: `Conflict: Row ${rowB.rowNumber} (${rowB.description}, ${rowB.paidByRaw}, ${rowB.amountRaw}) conflicts with Row ${rowA.rowNumber} (${rowA.description}, ${rowA.paidByRaw}, ${rowA.amountRaw}). Same date but different payer/amount.`,
              rawData: JSON.stringify(rowB),
              suggestedAction: JSON.stringify({
                action: 'RESOLVE_CONFLICT',
                conflictWithRowNumber: rowA.rowNumber
              })
            });
          }
        }
      }
    }
  }

  // Row by row anomaly checks
  for (const row of rows) {
    const rawDataStr = JSON.stringify(row);

    // 2. SETTLEMENT check
    const settlementRegex = /\b(settlement|settle|repay|paid back|pay back|transfer|repayment)\b/i;
    if (settlementRegex.test(row.description) || settlementRegex.test(row.notes)) {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'SETTLEMENT',
        description: `Notes/description suggest this row is a settlement rather than a normal expense.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'CONVERT_TO_SETTLEMENT'
        })
      });
    }

    // 3. NEGATIVE_AMOUNT check
    if (row.amount !== null && row.amount < 0) {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'NEGATIVE_AMOUNT',
        description: `Expense amount is negative (${row.amount}), which indicates a refund.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'MARK_AS_REFUND'
        })
      });
    }

    // 4. ZERO_AMOUNT check
    if (row.amount === 0) {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'ZERO_AMOUNT',
        description: `Expense amount is zero.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'SKIP_ROW'
        })
      });
    }

    // 5. MISSING_CURRENCY check
    if (!row.currencyRaw || row.currencyRaw.trim() === '') {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'MISSING_CURRENCY',
        description: `Currency column is blank.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'DEFAULT_TO_INR'
        })
      });
    }

    // 6. MISSING_PAYER check
    if (!row.paidByRaw || row.paidByRaw.trim() === '') {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'MISSING_PAYER',
        description: `Payer (paid_by) field is blank.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'REQUIRE_PAYER'
        })
      });
    }

    // 7. INVALID_DATE check
    if (!row.date) {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'INVALID_DATE',
        description: `Date '${row.rawDate}' cannot be parsed.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'REQUIRE_DATE'
        })
      });
    }

    // 8. AMBIGUOUS_DATE check
    if (row.rawDate) {
      const slashMatch = row.rawDate.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (slashMatch) {
        const val1 = parseInt(slashMatch[1], 10);
        const val2 = parseInt(slashMatch[2], 10);
        if (val1 <= 12 && val2 <= 12 && val1 !== val2) {
          // This is ambiguous!
          // We can suggest a format. If we parse DD/MM/YYYY, date is val1/val2.
          // Let's suggest both options to let user choose.
          // Format option 1: DD/MM (val1 Day, val2 Month) -> e.g. 04/05/2026 is May 4th.
          // Format option 2: MM/DD (val1 Month, val2 Day) -> e.g. 04/05/2026 is April 5th.
          const year = slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3];
          const d1 = new Date(Date.UTC(parseInt(year), val2 - 1, val1));
          const d2 = new Date(Date.UTC(parseInt(year), val1 - 1, val2));
          anomalies.push({
            rowNumber: row.rowNumber,
            anomalyType: 'AMBIGUOUS_DATE',
            description: `Date '${row.rawDate}' is ambiguous. It could be ${d1.toISOString().split('T')[0]} (DD/MM format) or ${d2.toISOString().split('T')[0]} (MM/DD format).`,
            rawData: rawDataStr,
            suggestedAction: JSON.stringify({
              action: 'SELECT_DATE_FORMAT',
              options: [
                { format: 'DD/MM/YYYY', date: d1.toISOString() },
                { format: 'MM/DD/YYYY', date: d2.toISOString() }
              ],
              recommended: 'DD/MM/YYYY' // Recommended based on surrounding rows 16-34
            })
          });
        }
      }
    }

    // 9. NAME_MISMATCH checks (Payer)
    if (row.paidByRaw && row.paidByRaw.trim() !== '') {
      const normName = normalizeName(row.paidByRaw);
      const exactMember = findMemberByName(normName);
      if (!exactMember) {
        const fuzzyMember = fuzzyFindMember(row.paidByRaw);
        if (fuzzyMember) {
          anomalies.push({
            rowNumber: row.rowNumber,
            anomalyType: 'NAME_MISMATCH',
            description: `Payer '${row.paidByRaw}' does not exactly match a group member. Fuzzy matched to '${fuzzyMember.name}'.`,
            rawData: rawDataStr,
            suggestedAction: JSON.stringify({
              action: 'NORMALIZE_NAME',
              originalName: row.paidByRaw,
              suggestedName: fuzzyMember.name,
              userId: fuzzyMember.id
            })
          });
        } else {
          // If no fuzzy member found, it's an external guest member
          anomalies.push({
            rowNumber: row.rowNumber,
            anomalyType: 'EXTERNAL_MEMBER',
            description: `Payer '${row.paidByRaw}' is not a registered member of this group.`,
            rawData: rawDataStr,
            suggestedAction: JSON.stringify({
              action: 'CREATE_GUEST',
              guestName: normName
            })
          });
        }
      } else {
        // Casing/whitespace exact match but raw strings differ
        if (row.paidByRaw !== exactMember.name) {
          anomalies.push({
            rowNumber: row.rowNumber,
            anomalyType: 'NAME_MISMATCH',
            description: `Payer name casing or trailing spaces: '${row.paidByRaw}' -> '${exactMember.name}'.`,
            rawData: rawDataStr,
            suggestedAction: JSON.stringify({
              action: 'NORMALIZE_NAME',
              originalName: row.paidByRaw,
              suggestedName: exactMember.name,
              userId: exactMember.id
            })
          });
        }
      }
    }

    // 10. MEMBERSHIP_VIOLATION checks
    if (row.date) {
      const expenseDate = new Date(row.date);
      
      // Check Payer membership window
      if (row.paidByRaw && row.paidByRaw.trim() !== '') {
        const payerMember = findMemberByName(row.paidByRaw) || fuzzyFindMember(row.paidByRaw);
        if (payerMember) {
          const joinedAt = payerMember.joinedAt;
          const leftAt = payerMember.leftAt;
          if (expenseDate < joinedAt || (leftAt && expenseDate > leftAt)) {
            anomalies.push({
              rowNumber: row.rowNumber,
              anomalyType: 'MEMBERSHIP_VIOLATION',
              description: `Payer '${payerMember.name}' was not an active member on ${expenseDate.toISOString().split('T')[0]}. Joined: ${joinedAt.toISOString().split('T')[0]}, Left: ${leftAt ? leftAt.toISOString().split('T')[0] : 'Never'}.`,
              rawData: rawDataStr,
              suggestedAction: JSON.stringify({
                action: 'ADJUST_MEMBERSHIP_WINDOW',
                userId: payerMember.id,
                date: expenseDate.toISOString()
              })
            });
          }
        }
      }

      // Check Split participants membership windows
      if (row.splitWith && row.splitWith.length > 0) {
        for (const pName of row.splitWith) {
          const partMember = findMemberByName(pName) || fuzzyFindMember(pName);
          if (partMember) {
            const joinedAt = partMember.joinedAt;
            const leftAt = partMember.leftAt;
            if (expenseDate < joinedAt || (leftAt && expenseDate > leftAt)) {
              anomalies.push({
                rowNumber: row.rowNumber,
                anomalyType: 'MEMBERSHIP_VIOLATION',
                description: `Participant '${partMember.name}' was not active on ${expenseDate.toISOString().split('T')[0]}. Joined: ${joinedAt.toISOString().split('T')[0]}, Left: ${leftAt ? leftAt.toISOString().split('T')[0] : 'Never'}.`,
                rawData: rawDataStr,
                suggestedAction: JSON.stringify({
                  action: 'REMOVE_INACTIVE_PARTICIPANT',
                  userId: partMember.id,
                  participantName: partMember.name
                })
              });
            }
          }
        }
      }
    }

    // 11. SPLIT_CONFLICT checks
    if (row.splitType === 'EQUAL' && row.splitDetails && row.splitDetails.trim() !== '') {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'SPLIT_CONFLICT',
        description: `Split type is set to EQUAL, but details are populated: '${row.splitDetails}'.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'USE_SPLIT_DETAILS',
          splitDetails: row.splitDetails
        })
      });
    }

    // 12. PERCENTAGE_MISMATCH checks
    if (row.splitType === 'PERCENTAGE' && row.splitDetails) {
      const parsedDetails = parseSplitDetails(row.splitDetails);
      const sum = parsedDetails.reduce((s, p) => s + p.value, 0);
      if (Math.abs(sum - 100) > 0.01) {
        anomalies.push({
          rowNumber: row.rowNumber,
          anomalyType: 'PERCENTAGE_MISMATCH',
          description: `Split percentages sum up to ${sum}%, not 100%. Details: '${row.splitDetails}'.`,
          rawData: rawDataStr,
          suggestedAction: JSON.stringify({
            action: 'NORMALIZE_PERCENTAGES',
            originalDetails: row.splitDetails,
            normalizedDetails: parsedDetails.map(p => `${p.name} ${Math.round((p.value / sum) * 100 * 100) / 100}%`).join('; ')
          })
        });
      }
    }

    // 13. EXTERNAL_MEMBER checks (split participants)
    if (row.splitWith && row.splitWith.length > 0) {
      for (const pName of row.splitWith) {
        const exactMember = findMemberByName(pName);
        if (!exactMember) {
          const fuzzyMember = fuzzyFindMember(pName);
          if (!fuzzyMember) {
            anomalies.push({
              rowNumber: row.rowNumber,
              anomalyType: 'EXTERNAL_MEMBER',
              description: `Participant '${pName}' is not a registered member of the group.`,
              rawData: rawDataStr,
              suggestedAction: JSON.stringify({
                action: 'CREATE_GUEST',
                guestName: normalizeName(pName)
              })
            });
          }
        }
      }
    }

    // 14. AMOUNT_FORMAT checks
    const amountStr = row.amountRaw ? row.amountRaw.toString().trim() : '';
    if (amountStr && (amountStr.includes(',') || amountStr !== row.amountRaw.toString())) {
      anomalies.push({
        rowNumber: row.rowNumber,
        anomalyType: 'AMOUNT_FORMAT',
        description: `Expense amount format contains commas or trailing spaces: '${row.amountRaw}'.`,
        rawData: rawDataStr,
        suggestedAction: JSON.stringify({
          action: 'AUTOCORRECT_AMOUNT',
          parsedAmount: row.amount
        })
      });
    }
  }

  return anomalies;
}
