import { parse } from 'csv-parse/sync';

/**
 * Standardizes name formats (trim and Title Case).
 * @param {string} name 
 * @returns {string}
 */
export function normalizeName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  // Standardize name casing to Title Case
  return trimmed.split(/\s+/).map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
}

/**
 * Tries to parse various date formats from the CSV.
 * Supported formats:
 * - YYYY-MM-DD (e.g., 2026-02-01)
 * - DD/MM/YYYY (e.g., 01/03/2026)
 * - Month DD (e.g., Mar 14) -> Infers year 2026
 * 
 * @param {string} dateStr 
 * @returns {Date|null}
 */
export function parseCSVDate(dateStr) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();

  // 1. Check YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed + 'T00:00:00.000Z');
    if (!isNaN(d.getTime())) return d;
  }

  // 2. Check DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const parts = trimmed.split('/');
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // 0-indexed month
    const year = parseInt(parts[2], 10);
    const d = new Date(Date.UTC(year, month, day, 0, 0, 0));
    if (!isNaN(d.getTime())) return d;
  }

  // 3. Check "Month DD" (e.g., Mar 14 or March 14)
  if (/^[a-zA-Z]+\s+\d{1,2}$/.test(trimmed)) {
    // Append year 2026
    const parts = trimmed.split(/\s+/);
    const monthStr = parts[0].substring(0, 3).toLowerCase();
    const day = parseInt(parts[1], 10);
    
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };

    if (months[monthStr] !== undefined) {
      const d = new Date(Date.UTC(2026, months[monthStr], day, 0, 0, 0));
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Fallback to native Date parser
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Strips commas and parses floats.
 * @param {string} val 
 * @returns {number|null}
 */
export function parseCSVAmount(val) {
  if (val === undefined || val === null || val === '') return null;
  // Strip commas and spaces
  const cleaned = val.toString().replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parses raw CSV string data into normalized objects.
 * @param {string} csvContent 
 * @returns {Array<Object>}
 */
export function parseCSV(csvContent) {
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((r, index) => {
    const rowNumber = index + 1; // 1-indexed for sheets
    
    const cleanedPayer = r.paid_by ? r.paid_by.trim() : '';
    const rawAmount = r.amount;
    const amountVal = parseCSVAmount(rawAmount);
    
    // Clean currency (empty defaults to INR)
    let currencyVal = r.currency ? r.currency.trim().toUpperCase() : 'INR';
    if (!currencyVal) currencyVal = 'INR';

    // Parse date
    const dateVal = parseCSVDate(r.date);

    // split_with list
    const splitWithArray = r.split_with
      ? r.split_with.split(';').map(x => x.trim()).filter(Boolean)
      : [];

    // split_details details
    const splitDetailsVal = r.split_details ? r.split_details.trim() : '';

    return {
      rowNumber,
      rawDate: r.date,
      date: dateVal,
      description: r.description ? r.description.trim() : '',
      paidByRaw: cleanedPayer,
      amount: amountVal,
      amountRaw: rawAmount,
      currency: currencyVal,
      currencyRaw: r.currency,
      splitTypeRaw: r.split_type,
      splitType: r.split_type ? r.split_type.trim().toUpperCase() : '',
      splitWithRaw: r.split_with,
      splitWith: splitWithArray,
      splitDetailsRaw: r.split_details,
      splitDetails: splitDetailsVal,
      notes: r.notes ? r.notes.trim() : '',
    };
  });
}
