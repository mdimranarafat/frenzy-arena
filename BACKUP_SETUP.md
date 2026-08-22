# Frenzy Sports Arena — Google Sheets Backup System

This adds an automatic, best-effort backup of every booking record into a
Google Sheet, so you have a human-readable copy of your booking history
independent of Firebase/Firestore, your website, or `admin.html`.

**Firestore remains the primary database.** Nothing about booking creation,
approval, rejection, cancellation, conflict prevention, or the security
rules that already protect customer data has changed. The Sheet is a
one-way, after-the-fact copy.

---

## A. Architecture summary

```
Customer / Admin action in index.html or admin.html
        │  (writes to Firestore exactly as before — unchanged)
        ▼
Firestore  bookings/{bookingId}
        │  onWrite trigger (fires AFTER the write already committed)
        ▼
Cloud Function: syncBookingToSheet   (functions/index.js)
        │  uses the Admin SDK — runs entirely server-side, never in the browser
        ▼
Google Sheets API  (functions/sheets.js, service-account auth)
        ▼
Your Google Sheet — one row per Booking ID, upserted in place
```

**Why this can't slow down or break a booking:** the Cloud Function is a
*separate* trigger that fires only after Firestore has already durably
committed the booking write. The customer's "Request Submitted
Successfully" message and the admin's approve/reject actions never wait on
Sheets at all — they already succeeded before this function even starts.

**Loop prevention:** after syncing, the function stamps the booking doc
with `sheetBackupStatus` / `lastSheetBackupAt` / `sheetBackupError`. That
stamp is itself a write to the same document, which would normally
re-trigger the function. Before doing any work, the function diffs the
old and new document (ignoring those three status fields) — if nothing
else changed, it exits immediately. No infinite loop, no wasted Sheets API
calls.

**Idempotency / no duplicate rows:** every sync looks up the row by
Booking ID in column A first. If found, it updates that row in place; if
not, it appends a new one. Running the same sync twice, or migrating the
same data twice, never creates a second row for the same booking.

**Failure handling:** each sync makes up to 3 attempts with backoff (1s,
2s). If all attempts fail, the function records `sheetBackupStatus:
'failed'` and the error message on the booking document — visible in
`admin.html` as a small "⚠ backup failed" note under that row's status —
and logs the failure in Cloud Functions logs. It never throws an error
back at a customer or blocks any Firestore write.

---

## B. Files changed / created

**New:**
- `functions/index.js` — the two Cloud Functions (sync trigger + migration)
- `functions/mapBooking.js` — maps a booking document to a sheet row
- `functions/sheets.js` — Google Sheets API client (find/upsert by Booking ID)
- `functions/package.json` — dependencies (`firebase-admin`, `firebase-functions`, `googleapis`)
- `functions/.gitignore`, `functions/.env.example` — no real secrets in either
- `firebase.json`, `.firebaserc` — Firebase project config (this project had none before)
- `firestore.rules` — your existing rules, extracted verbatim from README.md into a real file so they can be deployed with the CLI. **Not a single line was changed.**
- `BACKUP_SETUP.md` — this file

**Modified:**
- `admin.html`:
  - Approve handler now also writes `approvedBy: auth.currentUser.email` on the booking doc (one line added — this field didn't exist before, and you asked for "Approved By" in the backup).
  - Added an "Export CSV" button next to "Scan for Orphaned Slots", using data already loaded in the dashboard (no new backend calls).
  - Booking rows now show a small warning if that booking's last Sheets sync failed.
- `index.html`: **untouched.** No frontend booking/availability logic changed at all.

---

## C. Configuration steps (things only you can do)

### 1. Create the Google Sheet
1. Create a new Google Sheet (e.g. "Frenzy Bookings Backup").
2. Leave it otherwise empty — the first sync run creates the header row for you automatically, matching `functions/mapBooking.js`'s `HEADER_ROW`.
3. Copy the Sheet ID from its URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

### 2. Google Cloud project + service account
Your Firebase project (`frenzy-arena`) already **is** a Google Cloud project — use the same one.
1. [console.cloud.google.com](https://console.cloud.google.com) → select `frenzy-arena`.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create Credentials → Service Account.**
   - Name it something like `sheets-backup-bot`.
   - You do **not** need to grant it any project-level IAM role — sharing the specific Sheet with it (next step) is enough.
4. On the new service account → **Keys → Add Key → Create new key → JSON.** This downloads a JSON file containing `client_email` and `private_key`. **Treat this file as a secret. Do not commit it. Delete it from your Downloads folder after the next step.**

### 3. Share the Sheet with the service account
1. Open the JSON key file, copy the `client_email` value (looks like `sheets-backup-bot@frenzy-arena.iam.gserviceaccount.com`).
2. In your Google Sheet → **Share** → paste that email → give it **Editor** access → uncheck "Notify people" → Share.

### 4. Set Firebase secrets and config
From your project root (where `firebase.json` now lives):

```bash
# Non-secret values (safe as plain params):
firebase functions:config:set 2>/dev/null || true   # (no-op, kept for older CLI versions)

# Secrets — these prompt you to paste the value; never appear in shell history:
firebase functions:secrets:set SHEETS_SERVICE_ACCOUNT_EMAIL
# paste the client_email from the JSON key

firebase functions:secrets:set SHEETS_PRIVATE_KEY
# paste the private_key value from the JSON key, INCLUDING the
# "-----BEGIN PRIVATE KEY-----" / "-----END PRIVATE KEY-----" lines
```

For the two plain (non-secret) string params, the simplest approach with
2nd-gen functions is a `.env.<project-id>` file **at `functions/.env.frenzy-arena`**
(this file is NOT committed — it's covered by `functions/.gitignore`'s `.env*` rule,
but note that pattern only blocks `.env` / `.env.local`; add the
project-specific filename to `.gitignore` too, or set these as secrets as well
if you'd rather not have any local file):

```
SHEETS_SPREADSHEET_ID=<the Sheet ID from step 1>
SHEETS_TAB_NAME=Bookings
ADMIN_EMAIL=mdimran3067333@gmail.com
```

Now delete the downloaded JSON key file from your computer — it's stored
in Google Secret Manager via the commands above, and you no longer need
the local copy.

### 5. Install dependencies and deploy
```bash
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules
```
The `firestore:rules` deploy will push the **exact same rules** that were
already documented in your README — nothing about them changed, this just
puts them under version control and lets the CLI manage them going forward
instead of pasting into the Console by hand.

### 6. Verify
- Book a slot on the live site → within a few seconds, check Cloud Functions logs (`firebase functions:log`) for a `syncBookingToSheet` entry → check the Sheet for the new row.
- Approve it in `admin.html` → confirm the same row updates (not a new row) with `Booking Status = Approved` and `Approved By` filled in.

---

## D. Security review — how credentials are protected

- The service-account private key never appears in any file in this repo. It lives only in **Google Secret Manager**, set via `firebase functions:secrets:set`, and is injected into the Cloud Function's environment at runtime by Firebase — the same mechanism Google recommends for exactly this use case.
- The Sheets API client (`functions/sheets.js`) runs **only** inside the Cloud Function, under the Admin SDK's server environment. It is never bundled into `index.html` or `admin.html`, so it's never visible to a browser, view-source, or network tab.
- The Cloud Function itself only listens for Firestore write *events* — it doesn't expose an HTTP endpoint that accepts arbitrary data, so there's no way for a customer or a script to make it write something to the Sheet that wasn't already a real, rules-validated booking document.
- The one function that **is** externally callable — `migrateAllBookingsToSheet` — checks `request.auth.token.email` against the same admin email your existing Firestore rules use, and rejects (`permission-denied`) anyone else, including a logged-out caller.
- The Google Sheet itself is shared only with the service account (Editor) and whoever you personally share it with — it is not public, and nothing in this system makes it public.
- Your existing Firestore rules (`firestore.rules`) are **untouched**. Cloud Functions run under the Admin SDK, which always bypasses security rules by design — that's expected and is why the backup can read booking data at all without needing a rules change, and why customer phone/email/notes still can never be read by an unauthenticated site visitor through the normal app.

---

## E. Recovery procedure — using the Sheet if the app has a serious problem

If `index.html`, `admin.html`, your Firebase project, or its configuration
is ever damaged, defaced, or otherwise unusable, the Sheet gives you:

1. Every booking's **Booking ID, customer name, phone, email, facility,
   date, start/end time, duration, status, fee, and notes** — enough to
   manually honor existing reservations by phone/WhatsApp even with the
   site fully down.
2. Because rows are keyed by Booking ID and kept in sync on every status
   change, the Sheet reflects the **latest known status** (pending /
   approved / rejected / cancelled / completed) as of the last successful
   sync — check the `Last Sheet Backup At`-equivalent info via
   `admin.html`'s per-row "⚠ backup failed" indicator, or the
   `lastSheetBackupAt` field in the CSV export, to see how fresh a given
   row is.
3. If you need to rebuild Firestore from scratch, the Sheet is a
   human-readable record you can use to manually re-enter critical
   upcoming bookings while a developer restores the app — it's a backup
   for *your reference*, not an automatic restore mechanism (re-importing
   Sheet rows back into Firestore isn't built, since your ask was backup/
   reporting, not two-way sync).

---

## F. Existing data backup — running the one-time migration

This is safe to run once, and safe to re-run any time (e.g. after
recovering from an outage) — it never creates duplicates.

**From the browser**, while logged into `admin.html` as the admin:
1. Open the browser DevTools console on the `admin.html` page.
2. Run:
   ```js
   const functions = firebase.functions(); // or getFunctions(app) if using modular SDK imports already on the page
   const migrate = functions.httpsCallable('migrateAllBookingsToSheet');
   const result = await migrate();
   console.log(result.data);
   // { processed: N, succeeded: N, failed: 0, failedIds: [] }
   ```
   (If `admin.html`'s existing `<script type="module">` imports don't
   already include the Functions SDK, add:
   `import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";`
   and call `httpsCallable(getFunctions(app), 'migrateAllBookingsToSheet')`
   instead — matching the same modular-SDK style already used for
   Firestore in that file.)

3. Check the returned counts. If `failed > 0`, the `failedIds` array
   lists which booking IDs to investigate (check `firebase
   functions:log` for the specific error — usually a transient Sheets API
   rate limit; just re-run the migration and it will only need to retry
   the ones still marked `sheetBackupStatus: 'failed'`).

The migration pages through all bookings 200 at a time and upserts each
into the Sheet by Booking ID, so it's safe against the Sheets API's own
rate limits and safe to interrupt and re-run.

---

## What was intentionally left out (and why)

- **Payment Status / Payment Amount columns**: your current app has no
  payment-tracking feature — only an admin-set `bookingFee`. The sheet
  shows `bookingFee` under "Payment Amount" and "Booking Fee", and "N/A"
  under "Payment Status", rather than inventing a status your app doesn't
  actually track. If you add real payment tracking later, tell me and
  I'll wire it through both `admin.html` and `mapBooking.js`.
- **Two-way sync / restoring from the Sheet back into Firestore**: not
  built, per your own spec (#11: "Google Sheets should NOT become part of
  the critical booking transaction"). The recovery procedure above is
  manual by design.
- **Firestore rules changes**: none were needed or made. `approvedBy` and
  the `sheetBackup*` fields fit inside the existing, already-unrestricted
  `allow update: if isAdmin()` rule for bookings.
