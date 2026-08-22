'use strict';

const { google } = require('googleapis');
const { HEADER_ROW } = require('./mapBooking');

const DEFAULT_SHEET_TAB = 'Bookings';

let cachedSheetsClient = null;

/**
 * Builds an authenticated Sheets API client from service-account credentials.
 * Credentials come from Firebase Functions params/secrets (see index.js),
 * NEVER from files checked into the repo or from frontend code.
 */
function getSheetsClient({ clientEmail, privateKey }) {
  if (cachedSheetsClient) return cachedSheetsClient;

  if (!clientEmail || !privateKey) {
    throw new Error('Google service account credentials are not configured.');
  }

  // Cloud secrets store newlines as literal "\n" — restore real newlines.
  const normalizedKey = privateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: normalizedKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  cachedSheetsClient = google.sheets({ version: 'v4', auth });
  return cachedSheetsClient;
}

async function ensureHeaderRow(sheets, spreadsheetId, sheetTab) {
  const range = `${sheetTab}!A1:${colLetter(HEADER_ROW.length)}1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const existing = (res.data.values && res.data.values[0]) || [];
  const matches =
    existing.length === HEADER_ROW.length && existing.every((v, i) => v === HEADER_ROW[i]);
  if (!matches) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER_ROW] },
    });
  }
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Finds the 1-indexed sheet row number for a given Booking ID by scanning
 * column A. Returns null if not found. Sheets are small enough (single
 * venue) that a full-column read is cheap and simple; if this ever grows
 * into the tens of thousands of rows, switch to a cached lookup map.
 */
async function findRowByBookingId(sheets, spreadsheetId, sheetTab, bookingId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTab}!A2:A`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => r[0] === bookingId);
  return idx === -1 ? null : idx + 2; // +2: skip header, convert to 1-indexed
}

/**
 * Upserts a single booking row, matched by Booking ID in column A.
 * Idempotent: safe to call repeatedly with the same data.
 */
async function upsertBookingRow({ clientEmail, privateKey, spreadsheetId, sheetTab, bookingId, rowValues }) {
  const tab = sheetTab || DEFAULT_SHEET_TAB;
  const sheets = getSheetsClient({ clientEmail, privateKey });

  await ensureHeaderRow(sheets, spreadsheetId, tab);

  const existingRow = await findRowByBookingId(sheets, spreadsheetId, tab, bookingId);

  if (existingRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${existingRow}:${colLetter(rowValues.length)}${existingRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowValues] },
    });
    return { action: 'updated', row: existingRow };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] },
  });
  return { action: 'appended' };
}

module.exports = { upsertBookingRow, findRowByBookingId, ensureHeaderRow, getSheetsClient, colLetter };
