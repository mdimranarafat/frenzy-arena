# Frenzy Sports Arena — Website

A single-page site for Frenzy Sports Arena (6A Side Turf, 4A Side Turf, swimming pool, and carrom), Pahartali, Chittagong — with a request-based, admin-approved booking system covering all four facilities in 30-minute slots, 24 hours a day, and a centralized pricing engine that calculates each booking's price automatically.

## What's in here
- `index.html` — the public site, including the live booking calendar
- `admin.html` — password-protected admin dashboard for managing bookings, direct admin bookings, and corporate/recurring series
- `pricing.js` — the single, shared pricing calculation and facility list, imported as a native ES module by both of the above. **This file must be deployed alongside the other two** — both pages `import` from `./pricing.js` at load time, so it needs to sit in the same folder when you publish (e.g. same GitHub Pages root).

## Info used (pulled from Frenzy's Facebook page)
- Address: Beside Joy Nagar Jame Masjid (Opposite of North Greenview Gate), Port Connecting Road, Saraipara, Pahartali, Chittagong
- Phone: +880 1881-271887
- Email: frenzysportsctg@gmail.com
- Facebook: facebook.com/FrenzyChittagong
- Hours: Always open
- Reviews: 72% recommend (18 reviews)

Facility descriptions, FAQ answers, and section copy were written fresh for this site — double check them against what Frenzy actually offers before publishing.

---

## Booking system v2 — three facilities, 30-minute slots, admin-approved

This is **not** a self-serve, instant-booking system. Every customer booking starts as a request; only admin action makes it Booked. Admin can also create confirmed bookings directly, and set up recurring corporate bookings.

### Facilities
6A Side Turf, 4A Side Turf, Swimming Pool, and Carrom, each with **fully independent** availability — booking one never blocks the others. 6A Side Turf and 4A Side Turf are two separate physical pitches and two separate facility records; a booking on one has no effect on the other's availability, pricing, or conflict detection.

> **Migration note — read before deploying this version.** This facility list replaces a previous single `"futsalTurf"` facility. Existing booking/slot records with `facility: "futsalTurf"` were **not modified or deleted** by this update (per the requirement not to remove existing data), but they also don't automatically become either `"sixASideTurf"` or `"fourASideTurf"` — there's no way to safely infer which physical turf an old booking was actually for. Until those historical records are manually reassigned (or simply left as historical/closed-out bookings, since they're already in the past), admin filtering by "6A Side Turf" or "4A Side Turf" won't surface them. If there are any *upcoming* bookings still on `"futsalTurf"`, reassign those manually in Firestore before go-live so they don't silently disappear from both new facility views.

### Pricing
Every price is calculated by the single shared function `calculateBookingPrice()` in **`pricing.js`** — imported by both `index.html` and `admin.html`, so the customer-facing price and the admin-facing price can never drift apart. Nothing hardcodes a final price anywhere else in either file.

- **6A Side Turf / 4A Side Turf** — priced by time-of-day period, based on the booking's **start time**: DAY (5:00 AM–4:59 PM), NIGHT (5:00 PM–11:59 PM), MIDNIGHT (12:00 AM–4:59 AM). A published 60-minute and 90-minute rate exists per period per turf; any other duration (2h, 2h30, 3h, …) is extrapolated **linearly** — each additional 30-minute block costs the same as the 60→90-minute step did. That extrapolation wasn't explicitly specified in the pricing brief; it's the most defensible interpretation of two data points, isolated to one spot (`TURF_BASE` in `pricing.js`) if the real per-block rate differs.
- **Swimming Pool** — flat ৳200/hour, no time-of-day periods.
- **Carrom** — flat ৳150/hour, no time-of-day periods.
- **Thursday–Saturday surcharge** — the booking's **start date**'s weekday (never the end date, even if the booking crosses midnight or crosses into Thursday) determines the surcharge: `Math.floor((basePrice * 1.25) / 100) * 100`, always rounding **down** to the nearest ৳100, never `Math.round()`. Sunday–Wednesday bookings pay the base price with no adjustment.
- **Midnight-crossing bookings are priced once, by their start time/date** — never split into a Night portion + Midnight portion, and never re-priced onto the next calendar date, matching the existing start-time-based pricing behavior this system already used for everything else.
- **`calculatedPrice`** is computed and stored on the `bookings` document at creation time (customer request, admin direct booking, and individually per-occurrence for corporate/recurring series) and again if admin edits that specific booking's own facility/date/time/duration. It is **never** silently recalculated later if the pricing table in `pricing.js` changes — each booking keeps the price it was actually quoted at. This is separate from `bookingFee`/`showFeePublicly`, which remains an optional, admin-only manual override with its own public-visibility toggle, unchanged from before — the admin UI shows both side by side rather than merging them.
- ⚠️ **Known inconsistency in the original pricing brief, resolved by trusting the formula:** the brief's "SURCHARGE EXAMPLES" section listed `1250 → 1500 TK`, which contradicts both the formula and the brief's own later "IMPORTANT ROUNDING TESTS" list, which correctly gives `1250 → 1200 TK` (and matches the fully-worked 4A-Thursday-night-60-minute example, which is exactly this case). `pricing.js` implements `1250 → 1200`, consistent with the formula and every other example. Worth double-checking this is what was actually intended.

### Time model
- 48 possible **start times** per day, one every 30 minutes, covering the full 24 hours (12:00 AM through 11:30 PM).
- Minimum booking **duration** is 1 hour; duration options increase in 30-minute steps from there (1h, 1h30, 2h, 2h30, …), dynamically capped by however many consecutive 30-minute slots are actually open from the chosen start time.
- Bookings that cross midnight are handled correctly: the system tracks which calendar date each 30-minute interval falls on, so an 11:30 PM start with a 1.5-hour duration correctly reserves 11:30 PM–12:00 AM, 12:00 AM–12:30 AM, and 12:30 AM–1:00 AM (the last two on the next calendar date), all as **one** booking record. This has always been true of how a booking is *written* (`coveredIntervals`/`endPoint`, both pure Date-arithmetic, never string comparison) — but until this pass, the *duration dropdown* on both the public site and the admin panel only ever looked at the current calendar day's own availability, so a late-night start time couldn't actually be offered a duration that reached past midnight (and 11:30 PM specifically had no valid duration at all, since even the 1-hour minimum didn't fit in the 30 minutes left in the day). Start-time selection, the live calendar grid, and the admin bookings table were all already correct; only the duration calculation needed the fix. `consecutiveOpenFrom` (public site) and the New/Edit Booking duration calculators (admin) now also read a one-day lookahead of the same `slots` collection — same collection, same public security rules, just one calendar date further — so a duration crossing into the next day is offered and validated against that day's real occupancy. Wherever the UI shows a time that lands on the following calendar date, it's now labeled `(+1 day)` (booking form preview, detail panel, admin New/Edit Booking preview, admin bookings table, and the corporate-booking conflict list). No Firestore schema or security rule changes were needed — `endDate`/`endSlot` already existed on every booking record and were already being computed and stored correctly.
- All "today / past" logic runs on **Asia/Dhaka** time, computed from the visitor's device clock via `Intl.DateTimeFormat`, not the visitor's own timezone — so the site behaves the same for a customer in Dhaka and one browsing from abroad.

### Customer flow
Date → Facility → Start Time → Duration → Name & Phone (required; email/notes optional) → Review → **Send Request** → status `pending`. The visitor always sees **"Request Submitted Successfully,"** never "Booking confirmed."

**Validation before the button is enabled:**
- Name: required, cannot be blank or spaces-only.
- Phone: required, must match a Bangladesh mobile format — `01XXXXXXXXX` or `+8801XXXXXXXXX` (checked with `/^(?:\+?880|0)1[3-9]\d{8}$/`).

Once a slot is **Booked**, the public calendar shows the customer's first name/name under the time — tapping it opens a details panel with customer name, facility, date, time range, duration, and status. Phone, email, notes, and any internal/admin fields are **never** shown publicly — that data lives only in the admin-only `bookings` collection; the public `slots` collection only ever carries the name and (if the admin explicitly enabled it) the fee.

**End-of-booking display card:** when a booking's end time lands exactly on an otherwise-open slot (e.g. a 9:00–10:00 PM booking ending right at 10:00 PM), the calendar shows two cards at that 10:00 PM label: a dimmed, non-clickable "Booked · ends here" card carrying the outgoing customer's name, immediately followed by the normal actionable **Open** card. This is purely a rendering choice in `index.html` — it reads the previous slot's booking data, doesn't write anything, and doesn't change which slot is actually available. The underlying slot model is unchanged: bookings still only lock `[startSlot, startSlot + durationSlots)`, so 10:00 PM was already open and bookable before this card existed — the card just makes that boundary visible instead of customers having to infer it.

### Admin flow
In `admin.html`:
- **Pending Requests** — approve (with an optional booking fee, shown or hidden on the public site per your choice) or reject.
- **All Bookings** — every booking regardless of type/status, filterable by type, status, facility, date, and customer name/phone. Approved bookings can be edited, cancelled, or marked completed; rejected/cancelled ones can be deleted.
- **+ New Booking** — creates an already-Booked slot directly (no customer approval step), with the same name/phone/fee fields.
- **+ Corporate / Recurring** — pick a customer, facility, day(s) of week, date range, start time, and duration; the system checks every matching date for conflicts first. If any date already has a booking in that window, admin sees a **Conflict Found** list and chooses to skip those dates (creating the rest) or cancel the whole series. Each generated occurrence is its own booking record (`bookingType: "corporate_recurring"`, sharing one `recurringBookingId`) — never a single record standing in for the whole month.
- **Recurring Bookings** — lists every series with its occurrence count; "View Occurrences" lets admin cancel an individual date without touching the rest of the series; "Cancel Series" cancels every future (not past) occurrence and marks the series cancelled.

### Booking fee
Optional on approval, on direct admin bookings, and on corporate bookings. Stored as `bookingFee` / `feeCurrency` / `showFeePublicly`. It's purely informational — approval always books the slot whether or not a fee is entered — and customers can never set or see it unless `showFeePublicly` is `true`.

### Conflict prevention (still the important part)
Every booking — customer request, admin-direct, or a corporate occurrence — writes one lock-document per covered 30-minute interval (`slots/{facility}_{date}_{slotIndex}`) in the same atomic batch as the booking record. Firestore Security Rules only allow *creating* a slot document if it doesn't already exist (for the public path) or if the request comes from the admin account. Because the batch is all-or-nothing, if even one interval in a multi-hour request was just taken, the whole write fails and the visitor/admin is told to pick a different time — enforced inside Firestore itself, not just in page JavaScript. Admin-side flows (New Booking, Corporate Booking, Edit) also run a client-side availability check immediately before writing, purely to give a friendlier error message; the Firestore rule is what actually prevents the double-booking.

---

## Data model

### `users` (role assignment — see "Roles & manager accounts" below)
```
uid                (doc id — same as the Firebase Auth uid)
role               "super_admin" | "manager" | "customer"
businessId         "frenzy_001" (managers only; super_admin doesn't need one)
email
createdAt
```
`customer` is defined as a role for completeness (the brief calls for exactly three), but nothing in the app creates a customer account or a `/users` doc with this role today — customer bookings are still name/phone only, no login, exactly as before. This is a placeholder for a future customer-account feature, not something currently wired up.

### `businesses/frenzy_001` (the one and only business record)
```
name                "Frenzy"
managerUid          the manager's Firebase Auth uid
subscriptionStatus  "active" | "suspended"
subscriptionEnd     Firestore Timestamp — NOT a string
plan                "monthly"
monthlyFee          2000
```

### `bookings` (admin-only read)
```
bookingId          (doc id)
customerName, phone, email
facility            "sixASideTurf" | "fourASideTurf" | "swimmingPool" | "carrom"
businessId          "frenzy_001" — always this exact value; there is only one business
bookingDate         "YYYY-MM-DD" (the start date)
startSlot           0-47 (30-minute index into bookingDate)
durationSlots       number of 30-minute units (min 2 = 1 hour)
durationMinutes
endDate, endSlot     where the booking actually ends (may be the next calendar date)
status              "pending" | "approved" | "rejected" | "cancelled" | "completed"
bookingType         "customer_request" | "admin_direct" | "corporate_recurring"
bookingSource       "website" | "admin"
bookingFee, feeCurrency, showFeePublicly   admin-controlled optional manual override, unrelated to calculatedPrice
calculatedPrice     system-computed price (see "Pricing" below) — a snapshot taken at creation/edit time, never silently recalculated later
recurringBookingId  set on corporate occurrences, else null
notes
createdAt, updatedAt, approvedAt, rejectedAt
```

### `slots` (public read — the ONLY collection the public site queries)
One doc per occupied 30-minute interval, `{facility}_{date}_{slotIndex}`:
```
facility, date, slot
businessId          "frenzy_001"
status              "pending" | "approved"
bookingId
customerName        shown publicly once status is "approved"
startSlot, durationSlots   (so the UI can reconstruct the full booked range)
bookingFee, showFeePublicly
```
Phone, email, and notes are intentionally **never** written here.

### `recurringBookings` (admin-only)
```
recurringBookingId (doc id)
customerName, phone, email, facility
businessId          "frenzy_001"
pattern "weekly", daysOfWeek [0-6]
startDate, endDate, startSlot, durationSlots
feeType "perOccurrence" | "monthly", bookingFee, feeCurrency, showFeePublicly
notes, status "active" | "cancelled"
occurrenceCount, skippedDates
createdAt
```

---

## Set it up (required before any of this works)

### 1. Create the Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it (e.g. `frenzy-arena`) → Analytics is optional.
2. **Build → Firestore Database → Create database**. Start in **production mode**. Pick a region close to Bangladesh (e.g. `asia-south1` or `asia-southeast1`).
3. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**.
4. **Authentication → Users → Add user** — your own (super_admin) login, `mdimran3067333@gmail.com`, if it doesn't already exist.
5. **Project settings → Your apps → </> (Web)** → register (skip Hosting) → copy the `firebaseConfig` object.

### 2. Add your config
Both `index.html` and `admin.html` already have Frenzy's real project config filled in (search for `firebaseConfig` in either file if you ever need to point them at a new Firebase project — keep both files in sync).

### 3. Set Firestore security rules
Firestore → **Rules** tab → replace everything with this:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ---------- Role & subscription model ----------
    // Exactly three roles, exactly one business (businessId "frenzy_001" — Frenzy itself). This is
    // NOT a multi-tenant system; businessId is stored on every booking/slot/recurring record as
    // required data, but it is never used here to partition access between businesses, because
    // there is only ever one. Access is governed entirely by role + (for managers) subscription
    // status.
    function isSignedIn() { return request.auth != null; }

    function userDoc() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
    }

    function isSuperAdmin() {
      return isSignedIn() && userDoc().role == "super_admin";
    }

    function isManagerRole() {
      return isSignedIn() && userDoc().role == "manager";
    }

    function business() {
      return get(/databases/$(database)/documents/businesses/frenzy_001).data;
    }

    // A manager only has access while: they're assigned to Frenzy specifically, AND Frenzy's own
    // subscription is active and not yet expired. Either condition failing revokes access
    // immediately on the next request — no caching, no grace period, nothing client-controlled.
    function isActiveManager() {
      return isManagerRole()
        && userDoc().businessId == "frenzy_001"
        && business().subscriptionStatus == "active"
        && business().subscriptionEnd > request.time;
    }

    // Replaces the old single-hardcoded-email check. Every existing rule below that already called
    // isAdmin() keeps working unchanged — super_admin always passes; a manager passes only while
    // Frenzy's subscription is active.
    function isAdmin() {
      return isSuperAdmin() || isActiveManager();
    }

    // ---------- /users/{uid} — role assignment ----------
    // Firebase Authentication accounts are created manually (Console → Authentication → Add user);
    // this document is what actually grants a signed-in account any role at all. A brand-new
    // Auth user with no /users doc has no role and isAdmin() correctly evaluates to false for them.
    match /users/{uid} {
      allow read: if isSuperAdmin() || (isSignedIn() && request.auth.uid == uid);
      // Only super_admin can create or modify a role assignment — a manager has NO write access to
      // this collection at all, including their own document. This is what actually prevents a
      // manager from ever changing their own role, escalating to super_admin, or reassigning
      // themselves to a different businessId: there is no path, at the rules level, for them to
      // write here under any circumstance.
      allow create, update, delete: if isSuperAdmin();
    }

    // ---------- /businesses/frenzy_001 — subscription ----------
    match /businesses/{businessId} {
      // A manager can read their own business doc (so a suspended manager's Admin Panel can show
      // *why* they're locked out — "subscription inactive" — rather than a bare permission error).
      // Read access here does NOT require an active subscription; only write access does.
      allow read: if isSuperAdmin() || (isManagerRole() && userDoc().businessId == businessId);
      // Only super_admin can ever change subscriptionStatus, subscriptionEnd, managerUid, plan, or
      // monthlyFee. A manager has zero write access here — they cannot extend their own access,
      // reactivate a suspended subscription, or reassign the business to a different manager.
      allow create, update, delete: if isSuperAdmin();
    }

    match /slots/{slotId} {
      allow read: if true;

      // Public can place a "hold" on a slot only if it doesn't exist yet and
      // the fields look exactly like a fresh customer-request lock (status pending,
      // no fee visible). Admin bypasses this shape check entirely.
      allow create: if isAdmin() || (
        !exists(/databases/$(database)/documents/slots/$(slotId)) &&
        request.resource.data.status == "pending" &&
        request.resource.data.showFeePublicly == false &&
        request.resource.data.bookingFee == null &&
        request.resource.data.businessId == "frenzy_001" &&
        request.resource.data.keys().hasOnly([
          "facility","date","slot","status","bookingId","customerName",
          "startSlot","durationSlots","bookingFee","showFeePublicly","businessId"
        ])
      );

      // Only the admin can approve/edit (update) or free up (delete) a slot —
      // this is what actually turns Pending into Booked, or frees a rejected/cancelled one.
      allow update, delete: if isAdmin();
    }

    match /bookings/{bookingId} {
      // Public can submit a new pending customer request with exactly this shape —
      // they can never set status to "approved", set a fee, or mark it admin/corporate.
      // `calculatedPrice` IS allowed here — it's the system-computed price (pricing.js), never
      // something the visitor sets directly; a public write can carry any number in that field
      // (there's no way to validate it matches the rules' own price table without duplicating the
      // entire pricing logic into the rules themselves), but it's purely informational — nothing in
      // the app treats a booking's stored price as authorization for anything, so a tampered value
      // here can't be used to bypass a charge or unlock a permission. Admin should treat the
      // customer-supplied `calculatedPrice` as a display convenience, not a source of truth for
      // actual billing. `businessId` is asserted exactly, same reasoning as the other fixed fields.
      allow create: if isAdmin() || (
        request.resource.data.status == "pending" &&
        request.resource.data.bookingType == "customer_request" &&
        request.resource.data.bookingSource == "website" &&
        request.resource.data.bookingFee == null &&
        request.resource.data.showFeePublicly == false &&
        request.resource.data.recurringBookingId == null &&
        request.resource.data.businessId == "frenzy_001" &&
        request.resource.data.keys().hasOnly([
          "customerName","phone","email","facility","bookingDate","startSlot",
          "durationSlots","durationMinutes","endDate","endSlot","status","bookingType",
          "bookingSource","bookingFee","feeCurrency","showFeePublicly","calculatedPrice",
          "recurringBookingId","notes","businessId","createdAt","updatedAt","approvedAt","rejectedAt"
        ])
      );

      // Only the admin can read the customer list (protects phone/email) or
      // change status, fees, or any other field.
      allow read, update, delete: if isAdmin();
    }

    match /recurringBookings/{seriesId} {
      // Entirely an admin/internal collection — the public site never reads or writes it.
      allow read, write: if isAdmin();
    }
  }
}
```

**Note on existing data:** `businessId` is required going forward on every new write, but is deliberately **not** required for reads — existing `bookings`/`slots`/`recurringBookings` documents created before this change won't have it, and none of the rules above check for its presence on read, so nothing existing becomes invisible or inaccessible. It's worth running a one-time script (Firebase Console → Firestore, or a short Admin SDK script) to backfill `businessId: "frenzy_001"` onto pre-existing documents for consistency, but it isn't required for the app to keep working.

This design means: anyone can submit a pending customer request and place its slot locks; nobody but the logged-in admin account can read customer contact details, approve/reject/edit a booking, create an admin-direct or corporate booking, or set/reveal a fee — enforced by Firestore itself, not just the page's JavaScript.

### 4. Set up roles: your super_admin account + the manager account
The rules above are useless until the `/users` and `/businesses/frenzy_001` documents referenced in them actually exist — do this before trying to log into `admin.html`, or every login will fail with a permission error even though the password is correct (an authenticated user with no `/users` doc has no role, so `isAdmin()` correctly evaluates to `false` for them).

1. **Firestore → Data → Start collection → `users`.**
2. Find your own uid: **Authentication → Users**, copy the "User UID" next to `mdimran3067333@gmail.com`.
3. Create document with that uid as the **Document ID**, fields:
   ```
   role:       "super_admin"    (string)
   email:      "mdimran3067333@gmail.com"   (string)
   createdAt:  (timestamp — click the clock icon next to the field type, use "current time")
   ```
4. **Firestore → Data → Start collection → `businesses`**, Document ID exactly `frenzy_001`, fields:
   ```
   name:               "Frenzy"                (string)
   managerUid:          <manager's uid — from step 6 below>   (string)
   subscriptionStatus:  "active"                (string)
   subscriptionEnd:     (timestamp — pick a real date, e.g. one month out)
   plan:                "monthly"               (string)
   monthlyFee:          2000                    (number)
   ```
   `subscriptionEnd` **must** be added as a Firestore **Timestamp** field type, not a plain string — the security rules compare it directly against `request.time`, which only works against a real Timestamp. In the Firestore console's "Add field" dialog, set the field type dropdown to **timestamp**, not string.
5. **Authentication → Users → Add user** — create the manager's login (their own email + a password you set and hand off to them).
6. Copy the new user's **User UID** from that same Users list, and:
   - Go back to step 4 and fill in `managerUid` with it if you hadn't yet.
   - Create a second document in `users`, Document ID = that manager uid, fields:
     ```
     role:       "manager"       (string)
     businessId: "frenzy_001"    (string)
     email:      <manager's email>   (string)
     createdAt:  (timestamp — current time)
     ```

That's it — no code change is needed to add or remove a manager later. To revoke a specific manager entirely (not just suspend the subscription), delete their `/users/{uid}` document from the Firestore console; `admin.html` will sign them out and deny access on their next request. To suspend/restore access for the whole business without touching the manager's account at all, just edit `/businesses/frenzy_001`'s `subscriptionStatus` (`"active"` ↔ `"suspended"`) and/or extend `subscriptionEnd` — no bookings, slots, or recurring series are ever touched by this, and access is restored immediately on the next request once you set it back to active with a future `subscriptionEnd`.

### 5. Firestore index (may be needed)
The public calendar queries `slots` by `facility` + `date` together; the admin panel queries `bookings` ordered by `createdAt`, and filters `recurringBookings` similarly. Firestore usually creates the needed composite indexes automatically — if the browser console shows a "query requires an index" error with a link, click it; it finishes in a few seconds.

### 6. Push to GitHub and go live
See below. Once your config + rules + `/users` + `/businesses/frenzy_001` are in place, `index.html` shows live availability across all four facilities and `admin.html` lets both you and the manager log in and run the whole booking desk (subject to the manager's subscription staying active).

**Cost:** Firestore + Authentication's free tier (Spark plan) comfortably covers a single-venue system like this, even with four facilities and 48 daily slots.

### Migrating from the previous (hourly, 2-facility) version
If you had live data under the old `bookingRequests` collection with hourly slot docs, it predates this schema (48×30-min slots, facilities, `bookings` collection, fee fields). There's no automatic migration script here — recreate any still-relevant bookings through the admin panel's **+ New Booking**, or write a one-off script if you have many to carry over. Nothing here assumes the old data exists, so a fresh Firestore database works immediately.

## Admin access
Go to `https://<your-username>.github.io/<your-repo>/admin.html`, log in with either your super_admin email or the manager's email/password from Firebase Authentication → Users. Keep this URL and both sets of credentials private — it's not linked from the public site. Anyone who knows the URL but doesn't have valid credentials, or has credentials but no `/users` role doc, just sees a login screen or an immediate "access denied" message; they can't read or act on bookings without both a valid login **and** a matching role — enforced by the security rules, not just the page hiding itself. If the manager's subscription lapses, they're signed out and denied on their very next request, automatically, with no code change needed.

## Push to GitHub

```bash
cd frenzy-arena
git init
git add .
git commit -m "Initial site"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Go live with GitHub Pages
1. Repo → **Settings** → **Pages**
2. Source: `Deploy from a branch`
3. Branch: `main`, folder `/ (root)` → **Save**
4. Live at `https://<your-username>.github.io/<your-repo>/` within a minute or two

## Known limitations of this pass
- Editing a **whole recurring series at once** (e.g. "shift every future Sunday to 6pm") isn't built — admin can cancel individual occurrences or the entire remaining series, and edit any single booking (including one recurring occurrence) on its own via **Edit**. Shifting a whole series is a reasonable next feature if you need it.
- The admin-side availability checks (New Booking, Corporate Booking, Edit) are client-side reads done right before writing, to give a friendly error message — the actual guarantee against double-booking is the Firestore security rule requiring a slot document not already exist, same as the original design.
- Pricing beyond the published 60/90-minute rates is a linear extrapolation, not an explicitly specified business rule — see the "Pricing" section above.
- Historical `"futsalTurf"` records are not reassigned to 6A/4A automatically — see the migration note under "Facilities" above. **Do this before deploying if any upcoming bookings are still on the old facility value.**
- This was built and reviewed as code; it hasn't been exercised against a live Firebase project in this environment (no network access here), so run through the test list below once your Firebase project is wired up.

## ⚠️ Required Firestore rules update before deploying this version
This update added a new field, `calculatedPrice`, to what the public site writes when a customer submits a booking request. The **documented** rules above already include it in the public `bookings` create rule's `hasOnly([...])` field whitelist — but that's only this file. **Your actual, deployed Firestore Security Rules (in the Firebase console, or wherever your live rules file is) must be updated to match before you publish these updated `index.html`/`admin.html`/`pricing.js` files.** If you deploy the new site code against the old, un-updated live rules, every customer booking request will fail with a permission-denied error the instant someone submits, because the write will contain a field (`calculatedPrice`) the live rule doesn't recognize. Copy the updated `allow create` rule for `/bookings/{bookingId}` above into your live rules and publish it first.

## Suggested test pass
Covers the full 24-hour/48-slot range including 12:00/12:30 AM and 11:00/11:30 PM, a booking that crosses midnight, all three facilities independently, customer name/phone validation (including spaces-only names and non-BD numbers), pending → approve/reject → booked/rejected on the public calendar, an admin-direct booking appearing instantly as Booked, a corporate series with a deliberate conflict on one date (confirm "Skip Conflicting Dates" behavior), cancelling a single occurrence vs. the whole series, editing an approved booking to a new valid time, and confirming phone/email/notes never appear in the public calendar or its detail panel.
