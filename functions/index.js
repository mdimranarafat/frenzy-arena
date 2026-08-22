'use strict';

/**
 * Frenzy Sports Arena — Google Sheets backup sync.
 *
 * Firestore stays the primary, real-time source of truth for booking
 * availability and conflict prevention (unchanged — see index.html /
 * admin.html / firestore.rules, none of which this file touches).
 *
 * This file adds a SEPARATE, best-effort backup path:
 *   bookings/{bookingId} write  →  Cloud Function (Admin SDK)  →  Google Sheet
 *
 * Nothing here can block, slow down, or fail a customer's booking —
 * the trigger fires AFTER a write already committed to Firestore.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

const { mapBookingToRow } = require('./mapBooking');
const { upsertBookingRow } = require('./sheets');

admin.initializeApp();
const db = admin.firestore();

// ---------- configuration (set via `firebase functions:secrets:set` / params) ----------
// See BACKUP_SETUP.md for exact commands. None of these are ever committed to the repo.
const GOOGLE_SERVICE_ACCOUNT_EMAIL = defineSecret('SHEETS_SERVICE_ACCOUNT_EMAIL');
const GOOGLE_PRIVATE_KEY = defineSecret('SHEETS_PRIVATE_KEY');
const SPREADSHEET_ID = defineString('SHEETS_SPREADSHEET_ID');
const SHEET_TAB = defineString('SHEETS_TAB_NAME', { default: 'Bookings' });
const ADMIN_EMAIL = defineString('ADMIN_EMAIL', { default: 'mdimran3067333@gmail.com' });

// Fields written BY this backup system itself. Any write that only touches
// these must NOT re-trigger a sync, or every sync would loop forever.
const BACKUP_STATUS_FIELDS = ['sheetBackupStatus', 'lastSheetBackupAt', 'sheetBackupError'];

function stripBackupFields(data) {
  if (!data) return data;
  const copy = { ...data };
  for (const f of BACKUP_STATUS_FIELDS) delete copy[f];
  return copy;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function syncWithRetry(bookingId, data, maxAttempts = 3) {
  const rowValues = mapBookingToRow(bookingId, data);
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await upsertBookingRow({
        clientEmail: GOOGLE_SERVICE_ACCOUNT_EMAIL.value(),
        privateKey: GOOGLE_PRIVATE_KEY.value(),
        spreadsheetId: SPREADSHEET_ID.value(),
        sheetTab: SHEET_TAB.value(),
        bookingId,
        rowValues,
      });
      return { ok: true };
    } catch (err) {
      lastErr = err;
      logger.warn(`Sheets sync attempt ${attempt}/${maxAttempts} failed for booking ${bookingId}`, err);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000)); // 1s, 2s backoff
      }
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Fires on every create/update/delete of a booking document.
 * - Create or real field update  → sync to Sheets.
 * - Delete                       → no-op (this app never deletes bookings;
 *                                   statuses like 'cancelled'/'rejected' are
 *                                   used instead — see admin.html).
 * - Update that ONLY changed our own backup-status fields → skip (loop guard).
 */
exports.syncBookingToSheet = onDocumentWritten(
  {
    document: 'bookings/{bookingId}',
    secrets: [GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY],
    region: 'asia-south1',
  },
  async (event) => {
    const bookingId = event.params.bookingId;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;

    if (!after) {
      logger.info(`Booking ${bookingId} deleted — nothing to sync (bookings are never deleted by the app).`);
      return;
    }

    if (before && deepEqual(stripBackupFields(before), stripBackupFields(after))) {
      // Only our own status fields changed — this IS the loop-prevention check.
      return;
    }

    const result = await syncWithRetry(bookingId, after);

    // This update touches ONLY backup-status fields, so the loop guard above
    // will correctly skip re-processing it.
    const statusUpdate = result.ok
      ? {
          sheetBackupStatus: 'synced',
          lastSheetBackupAt: admin.firestore.FieldValue.serverTimestamp(),
          sheetBackupError: null,
        }
      : {
          sheetBackupStatus: 'failed',
          lastSheetBackupAt: admin.firestore.FieldValue.serverTimestamp(),
          sheetBackupError: String(result.error && result.error.message ? result.error.message : result.error).slice(0, 500),
        };

    try {
      await db.collection('bookings').doc(bookingId).update(statusUpdate);
    } catch (err) {
      // If even this status write fails (e.g. doc was deleted in the meantime),
      // just log it — never throw, never affect the booking itself.
      logger.error(`Could not write backup status for booking ${bookingId}`, err);
    }

    if (!result.ok) {
      logger.error(`Sheets backup FAILED for booking ${bookingId} after retries`, result.error);
    }
  }
);

/**
 * One-time (or re-runnable) migration: pages through every existing booking
 * and upserts it into the Sheet. Admin-only — checks the caller's auth
 * token email against the same admin email used by your Firestore rules.
 *
 * Call from the browser console while logged into admin.html as:
 *   const fn = firebase.functions().httpsCallable('migrateAllBookingsToSheet');
 *   await fn({});
 * (or via `firebase functions:shell` / a temporary admin script — see
 * BACKUP_SETUP.md for the exact steps.)
 */
exports.migrateAllBookingsToSheet = onCall(
  {
    secrets: [GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY],
    region: 'asia-south1',
    timeoutSeconds: 540,
    memory: '256MiB',
  },
  async (request) => {
    if (!request.auth || request.auth.token.email !== ADMIN_EMAIL.value()) {
      throw new HttpsError('permission-denied', 'Only the admin account can run the migration.');
    }

    const pageSize = 200;
    let lastDoc = null;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const failedIds = [];

    for (;;) {
      let q = db.collection('bookings').orderBy('__name__').limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        processed++;
        const result = await syncWithRetry(doc.id, doc.data());
        if (result.ok) {
          succeeded++;
          await doc.ref.update({
            sheetBackupStatus: 'synced',
            lastSheetBackupAt: admin.firestore.FieldValue.serverTimestamp(),
            sheetBackupError: null,
          }).catch((e) => logger.error(`Migration: could not stamp status for ${doc.id}`, e));
        } else {
          failed++;
          failedIds.push(doc.id);
          await doc.ref.update({
            sheetBackupStatus: 'failed',
            lastSheetBackupAt: admin.firestore.FieldValue.serverTimestamp(),
            sheetBackupError: String(result.error && result.error.message ? result.error.message : result.error).slice(0, 500),
          }).catch((e) => logger.error(`Migration: could not stamp status for ${doc.id}`, e));
        }
      }

      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < pageSize) break;
    }

    logger.info(`Migration complete: ${processed} processed, ${succeeded} succeeded, ${failed} failed.`);
    return { processed, succeeded, failed, failedIds };
  }
);
