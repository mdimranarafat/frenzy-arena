# Frenzy Sports Arena — Website & Booking System

A production booking system for Frenzy Sports Arena (Futsal Turf, Swimming Pool, Carrom), Pahartali, Chittagong.

## What's in here
```
frenzy-arena/
├── index.html                 — public site + live booking calendar
├── admin.html                 — password-protected admin dashboard
├── firestore.rules            — Firestore security rules (source of truth — deploy this, not the Console copy)
├── firestore.indexes.json     — the one composite index the app actually needs
├── firebase.json              — Firestore-only config (deliberately no Hosting/Functions — stays on the free Spark plan)
├── .firebaserc                — Firebase project alias (frenzy-arena)
├── Code.gs                    — Google Apps Script: daily Firestore → Google Sheets backup
├── SECURITY_AUDIT.md          — security audit report
└── README.md                  — this file
```

`Code.gs` isn't deployed via the Firebase CLI — it lives in a separate Google Apps Script project bound to your Google Sheet (see the Backup System section below). Keep a copy in this repo for version history even though it's deployed differently.

## Info used (pulled from Frenzy's Facebook page)
- Address: Beside Joy Nagar Jame Masjid (Opposite of North Greenview Gate), Port Connecting Road, Saraipara, Pahartali, Chittagong
- Phone: +880 1881-271887
- Email: frenzysportsctg@gmail.com
- Facebook: facebook.com/FrenzyChittagong
- Hours: Always open
- Reviews: 72% recommend (18 reviews)

Facility/FAQ copy was written fresh — double check against what Frenzy actually offers before publishing.

---

## How the booking system works

**Three independent facilities** — Futsal Turf, Swimming Pool, Carrom — each with its own 24-hour, 30-minute-interval schedule (48 slots/day). Booking one never blocks another.

**Customer flow:**
1. Pick a date + facility → see the day's availability (Open / Pending / Booked / Past, in Asia/Dhaka time).
2. Tap an Open slot → pick a start time and a duration (minimum 1 hour, in 30-minute steps — the dropdown only offers durations that actually fit the consecutive open time from that start, including across midnight).
3. Enter name + phone (validated against Bangladesh formats: `01XXXXXXXXX` or `+8801XXXXXXXXX`) + optional email/notes.
4. Submit → **"Request Submitted Successfully."** Status is `pending`. It is never instantly booked.
5. Those hours show as **Pending** to everyone else (not selectable) until the admin acts.

**Admin flow (`admin.html`):**
- **Approve** a pending request → optionally set a Booking Fee and whether to show it publicly → hours become **Booked**, and the site shows the customer's name on those slots (never phone/email/notes — those stay admin-only).
- **Reject** → hours free back to Open.
- **+ New Booking** → admin creates a booking directly (status goes straight to Booked, no approval step), with the same conflict checking as the customer flow.
- **+ Corporate / Recurring Booking** → pick days of the week, a date range, a time, and a duration; the system generates every occurrence, checks each one against existing bookings, shows you a conflict report, and lets you **skip conflicts and create the rest** or cancel and start over.
- **Recurring Bookings tab** → view a series' occurrences, or **Cancel Series** (frees every *future* occurrence; past ones are never touched).
- **Edit** an approved booking, **Cancel** it, or **Mark Completed**.
- Filters: search by name/phone, and filter by date, facility, booking type, and status.

### Conflict prevention (the core guarantee)
Every facility/date/half-hour combination has its own tiny "lock" document in the `slots` collection (e.g. `futsalTurf_2026-08-15_1730`). Creating a booking — whether a customer request, an admin direct booking, or one occurrence of a recurring series — writes the booking doc *and* one lock-document per half-hour it covers, all in a single atomic Firestore batch. Firestore Security Rules only allow creating a lock-document if it doesn't already exist. Since the batch is all-or-nothing, if even one half-hour in a multi-hour request was just taken, the *entire* booking fails — no partial overlaps, ever. **This check runs inside Firestore itself** (the rules execute server-side), not just in the page's JavaScript, satisfying "backend must validate, not just frontend."

### Midnight crossing
Each half-hour lock-document is tagged with its own actual calendar date, so a booking like 11:30 PM → 1:00 AM correctly creates locks on *both* the start date and the next date. The public grid, the admin table, and the detail popup all display this correctly (e.g. "11:30 PM – 1:00 AM (+1d)").

### What's public vs. admin-only
The public site can only ever see: customer name (on booked slots only), facility, date, time, duration, status, and the booking fee *if* the admin explicitly checked "show fee publicly." Phone, email, notes, and the full customer list are only readable by an authenticated admin — enforced by security rules, not just by hiding it in the UI.

---

## Known simplifications (read before relying on these)

I want to be upfront about where I scoped things down, rather than quietly cutting corners:

- **I have not been able to test this against your live Firebase project** — no network access in my environment. Everything is syntax-checked and the core date/time/conflict logic is unit-tested (see below), but you'll be the first real end-to-end test. Try a few bookings — including one that crosses midnight — before relying on this for real customers.
- **Editing an approved booking's date/time/facility** is implemented as two separate steps (free the old slots, then claim the new ones) rather than one atomic operation, because Firestore batches don't cleanly support "delete this, then create that" when they might target the same document. In the rare case the new time gets taken by someone else in between those two steps, the booking's *old* slots are already freed and you'd need to manually re-book. Editing just the name/phone/fee/notes (no reschedule) doesn't have this risk.
- **Recurring series editing** (changing an already-created series' time/days in place) isn't implemented — only create, view, and cancel (whole series or the admin can cancel/edit individual occurrences from the main Bookings tab). To change a series, cancel it and create a new one.
- **Recurring "Custom Days" pattern** is merged into "Weekly on selected day(s)" — pick whichever days you want; functionally identical, one less dropdown.
- **Corporate booking duration options** are offered as a fixed list (1–4 hours) at creation time, since availability differs per occurrence — actual conflicts are only known once you click "Check Availability & Review."
- Firestore rules can't easily express "reject if this overlaps ANY existing range" in one line (no loops/joins in rules), which is why the design uses the per-half-hour lock-document trick above instead of a single overlap check — it fully solves the same problem, just structured differently than a typical SQL "no overlapping ranges" constraint.

None of these affect the core guarantee: **two people can never end up with the same approved half-hour.**

---

## Set it up

### 1. Firebase project (already created: `frenzy-arena`)
If starting fresh:
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Build → Firestore Database → Create database** (production mode; a region near Bangladesh, e.g. `asia-south1`).
3. **Build → Authentication → Sign-in method → Email/Password → Enable**.
4. **Authentication → Users → Add user** — this becomes your admin login for `admin.html`.
5. **Project settings → Your apps → </> (Web)** → copy the `firebaseConfig` object into both `index.html` and `admin.html` (search for `firebaseConfig` in each — already filled in with Frenzy's real project).

### 2. Set Firestore security rules
Firestore → **Rules** tab → paste this (already has your admin email, `mdimran3067333@gmail.com`, filled in):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isAdmin() {
      return request.auth != null &&
             request.auth.token.email == "mdimran3067333@gmail.com";
    }

    function isValidBDPhone(phone) {
      return phone is string && phone.matches('^(\\+?880|0)1[3-9][0-9]{8}$');
    }

    function isReasonableString(s, maxLen) {
      return s is string && s.size() > 0 && s.size() <= maxLen;
    }

    function isValidFacility(f) {
      return f in ["futsalTurf", "swimmingPool", "carrom"];
    }

    match /slots/{slotId} {
      allow read: if true;

      // Public can place a half-hour "hold" (pending) only if it doesn't already exist.
      // Admin can also create a slot directly as "approved" (direct/corporate bookings) —
      // the !exists() check still guarantees no double-booking either way.
      allow create: if !exists(/databases/$(database)/documents/slots/$(slotId)) && (
        (request.resource.data.status == "pending"
          && request.resource.data.keys().hasOnly(["facility","date","hhmm","status","bookingId","createdAt"])
          && isValidFacility(request.resource.data.facility)
          && request.resource.data.bookingId is string
          && request.resource.data.createdAt == request.time)
        ||
        (isAdmin() && request.resource.data.status == "approved"
          && request.resource.data.keys().hasOnly(["facility","date","hhmm","status","bookingId","customerName","feePublic","feeCurrency","createdAt"])
          && isValidFacility(request.resource.data.facility)
          && request.resource.data.createdAt == request.time)
      );

      // Only the admin can approve (update) or free up (delete) a slot
      allow update, delete: if isAdmin();
    }

    match /bookings/{bookingId} {
      // Public can submit a pending customer request with exactly these fields —
      // validated server-side (type, format, and range), and cannot set a fee,
      // cannot self-approve, cannot attach to a recurring series.
      allow create: if
        (request.resource.data.status == "pending"
          && request.resource.data.bookingType == "customer_request"
          && request.resource.data.bookingFee == null
          && request.resource.data.showFeePublicly == false
          && request.resource.data.recurringBookingId == null
          && isValidFacility(request.resource.data.facility)
          && isReasonableString(request.resource.data.customerName, 100)
          && isValidBDPhone(request.resource.data.phone)
          && request.resource.data.startMinutes is int
          && request.resource.data.startMinutes >= 0
          && request.resource.data.startMinutes < 1440
          && request.resource.data.durationMinutes is int
          && request.resource.data.durationMinutes >= 60
          && request.resource.data.durationMinutes % 30 == 0
          && request.resource.data.endMinutes == request.resource.data.startMinutes + request.resource.data.durationMinutes
          && (request.resource.data.notes == null || isReasonableString(request.resource.data.notes, 500))
          && request.resource.data.createdAt == request.time
          && request.resource.data.keys().hasOnly([
               "customerName","phone","email","facility","bookingDate",
               "startMinutes","durationMinutes","endMinutes","notes","status",
               "bookingType","bookingSource","bookingFee","feeCurrency","showFeePublicly",
               "recurringBookingId","createdAt","updatedAt","approvedAt","rejectedAt"
             ]))
        ||
        (isAdmin()
          && request.resource.data.bookingType in ["admin_direct","corporate_recurring"]
          && request.resource.data.keys().hasOnly([
               "customerName","phone","email","facility","bookingDate",
               "startMinutes","durationMinutes","endMinutes","notes","status",
               "bookingType","bookingSource","bookingFee","feeCurrency","showFeePublicly",
               "recurringBookingId","createdAt","updatedAt","approvedAt","rejectedAt"
             ]));

      // Only the admin can read the customer list or change a booking's status/details
      allow read, update, delete: if isAdmin();
    }

    match /recurringBookings/{seriesId} {
      allow read, write: if isAdmin();
    }
  }
}
```

**If you ever change your admin login email**, update the `isAdmin()` line above to match — it must be the *exact* email registered under Authentication → Users, or the dashboard will show "logged in" but fail to read/write anything.

**CSV export & dashboard stats:** `admin.html` now has an "Export CSV" button (UTF-8 BOM-prefixed so Bangla/English text opens correctly in Excel, respects your current filters), plus Today/This Week/This Month summary cards (bookings, revenue, booked hours, top facility). The "Scan for Orphaned Slots" tool from the earlier audit was removed per a later request — the underlying conflict-prevention guarantees it was checking are unaffected; if you want that safety net back later, it's a small addition.

### 3. Firestore indexes (may prompt you once)
Two queries need composite indexes the first time they run:
- `slots` filtered by `facility` + `date` (used by both the public grid and admin's per-day checks)
- `slots` filtered by `facility` + a `date` range (used by the corporate-booking conflict check)
- `bookings` filtered by `recurringBookingId` + `status` (used by Cancel Series)

Firestore doesn't block you — the *first* time each query runs, the browser console will show a "query requires an index" error with a direct link. Click it, wait ~30 seconds for the index to build, and retry. You'll likely see this the first time you use each admin feature.

### 4. Push to GitHub

```bash
cd frenzy-arena
git init
git add .
git commit -m "Initial site"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### 5. Go live with GitHub Pages
1. Repo → **Settings** → **Pages**
2. Source: `Deploy from a branch`
3. Branch: `main`, folder `/ (root)` → **Save**
4. Live at `https://<your-username>.github.io/<your-repo>/` within a minute or two

**Cost:** Firestore + Authentication's free tier (Spark plan) comfortably covers a single-venue system like this. Nothing in this project (including the backup system below) requires the paid Blaze plan.

### 6. Deploy `firestore.rules` and `firestore.indexes.json` via the Firebase CLI (optional but recommended)
Now that these are real files instead of Console copy-paste, you can deploy them properly:
```bash
npm install -g firebase-tools   # if you don't have it
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```
This deploys to the `frenzy-arena` project (set in `.firebaserc`). You can still paste rules into the Console manually if you prefer — just make sure `firestore.rules` in this repo stays the source of truth so the two don't drift apart.

---

## Backup System — Google Sheets (`Code.gs`)

**Architecture:** Firestore stays the only database the live site talks to — this backup is entirely separate and read-only from Firestore's perspective. Once a day, a Google Apps Script (bound to your existing Sheet) reads every booking from Firestore via the REST API — authenticating as a dedicated service account — and upserts each one into a "Bookings" tab, matched by Booking ID so re-running never creates duplicates. A "Backup Log" tab records every run. This deliberately avoids Cloud Functions (which require the paid Blaze plan) — Apps Script is free and runs entirely outside Firebase.

Your Sheet: `18azspQLSNou19biZ_3NvWInGgRPdBMG6ImKyF91B0k0`

### Setup steps

1. **Create a service account** (Google Cloud Console → your `frenzy-arena` project → IAM & Admin → Service Accounts → Create Service Account). Name it something like `sheets-backup-reader`.
2. **Grant it read-only Firestore access**: on the service account, add the role **Cloud Datastore Viewer** at the project level. This is intentionally read-only — the backup should never be able to write to your live booking data.
3. **Create a JSON key** for that service account (Keys tab → Add Key → JSON) and download it. This file is a secret — never commit it to GitHub.
4. **Confirm the Cloud Firestore API is enabled** (APIs & Services → Library → search "Cloud Firestore API") — it already is, since your live site uses Firestore.
5. **Open your Google Sheet** → Extensions → Apps Script. Delete the default `Code.gs` boilerplate and paste in the `Code.gs` from this repo.
6. **Set Script Properties** (gear icon → Project Settings → Script Properties → Add property), four values:
   - `FIREBASE_PROJECT_ID` = `frenzy-arena`
   - `SHEET_ID` = `18azspQLSNou19biZ_3NvWInGgRPdBMG6ImKyF91B0k0`
   - `SERVICE_ACCOUNT_KEY` = the full contents of the JSON key file you downloaded in step 3
   - `ADMIN_ALERT_EMAIL` = `mdimran3067333@gmail.com` (optional — you'll get an email if a backup run has errors)
7. **Set the project timezone to Asia/Dhaka** (still in Project Settings → General settings) so the daily 3 AM run happens at 3 AM your time.
8. **You do NOT need to share the Sheet with the service account.** The service account is only used to *read* Firestore; writing to the Sheet happens as whichever Google account owns this Apps Script project (you) — which already has access to your own Sheet.
9. In the Apps Script editor, select `manualBackupTest` from the function dropdown and click **Run**. The first run will ask you to authorize the script (it needs permission to call external services and send email) — approve it. You should see a popup summary, and a "Bookings" tab should appear in your Sheet populated with every existing booking — this doubles as your one-time historical migration, since the script always does a full resync.
10. Once that works, run `createDailyTrigger` once (same dropdown-and-Run process) to install the automatic daily schedule. It's idempotent — safe to run again if you're ever unsure whether it's installed.

### Why a full resync every day, not incremental
Simpler and self-healing: if one day's run fails partway through, the next day's full resync catches everything up automatically, with no need to track "since when" cursors. At single-venue scale this comfortably finishes well within Apps Script's execution time limits.

### Recovery procedure
If the live site, Firebase project, or Firestore data is ever damaged or inaccessible, the Sheet's "Bookings" tab is a complete, human-readable, independent copy of every booking as of the last daily run — open it directly in Google Sheets, no code or Firebase access required. The "Backup Log" tab tells you exactly when each run happened and whether it succeeded, so you know how current that copy is.

### Privacy note
This Sheet contains customer names, phone numbers, and emails — treat its sharing settings the same way you'd treat the admin dashboard. Don't set it to "Anyone with the link."

---

## Admin access
`https://<your-username>.github.io/<your-repo>/admin.html` — log in with the email/password from Authentication → Users. This URL isn't linked from the public site, but it's not secret either — the real protection is the security rules: without valid admin credentials, the page loads but can't read or write any booking data.

## Testing checklist (do this before trusting it with real customers)
- Book a slot as a customer, confirm it shows Pending, then approve it in admin and confirm it shows Booked with your name.
- Try requesting an already-Pending or already-Booked hour — it should not be selectable.
- Book 11:30 PM for 1.5 hours and confirm it correctly shows as crossing into the next day, on both the public grid and in admin.
- Create a direct admin booking that would overlap an existing one — it should be blocked.
- Create a small corporate series (e.g. 2 weeks, one weekday) with a deliberate conflict on one occurrence, confirm the conflict is detected, skip it, and confirm the rest are created.
- Cancel a recurring series and confirm only *future* occurrences are freed.
