# Frenzy Sports Arena — Security Audit & Hardening Report

**Scope:** `index.html` (public site), `admin.html` (admin dashboard), and the Firestore data model / security rules that back both.
**Method:** Manual code review of every read/write path, the security rules, and the client-side validation logic. I do not have network access to your live Firebase project, so nothing here was tested against real traffic — treat this as a thorough desk review, and re-verify the Critical/High items yourself once the fixes are live.
**Status:** Findings 1–3 have already been fixed in the code delivered alongside this report. Findings 4–7 need action on your end (mostly Firebase Console settings I can't change for you).

---

## Summary table

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Orphaned slot locks — a slot could be permanently reserved with no matching booking record | **High** | Fixed in code |
| 2 | No server-side validation of field types, string length, or numeric ranges | **Medium** | Fixed in rules |
| 3 | Phone number format was only validated client-side | **Medium** | Fixed in rules |
| 4 | No abuse/spam protection on public writes (booking-slot flooding) | **High** | Needs your action |
| 5 | Firebase Web API key has no HTTP-referrer restriction | Low | Needs your action |
| 6 | Admin account has no multi-factor authentication | Medium | Needs your action |
| 7 | No monitoring/alerting on admin sign-ins or unusual write volume | Low | Optional |

---

## 1. Orphaned slot locks (High) — Fixed

**The issue:** Availability is enforced by tiny "lock" documents in the `slots` collection — one per half-hour, keyed by facility/date/time. The old rules let anyone create one of these with just a `bookingId` string, an `!exists()` check, and a `status: "pending"` value. Nothing required that `bookingId` to actually point at a real document in the `bookings` collection.

That means someone calling the Firestore SDK directly (bypassing your web page entirely — trivial to do, it's just JavaScript in the browser) could write a `slots` document with a made-up `bookingId` and permanently lock that half-hour. Your admin dashboard only ever looks at the `bookings` collection to find things to approve or reject, so a lock like this would never show up anywhere for you to act on. Do this across a lot of slots and you'd have a griefing/denial-of-service problem — real customers unable to book anything, with no obvious cause.

**What I fixed:**
- Every slot document now records `createdAt` (a server timestamp), which the rules verify was actually set by the server (`== request.time`) — this alone doesn't stop the attack, but it's needed for the cleanup tool below and for any future investigation.
- Added a **"Scan for Orphaned Slots"** button to `admin.html`. It checks every locked slot over the next 90 days against its linked booking record and flags any where the booking is missing or its status no longer matches (e.g. a slot still shows Pending after its booking was actually rejected — which can also happen from an interrupted request, not just an attack). One click deletes everything it finds. Run this periodically, or whenever availability looks wrong.

**What I didn't do, and why:** The fully "correct" fix is a rule that cross-checks `exists(/databases/$(database)/documents/bookings/$(request.resource.data.bookingId))` at write time. I left this out because your booking flow writes the `bookings` doc and its `slots` docs *in the same atomic batch* — and I could not verify, without live testing, whether Firestore evaluates that `exists()` check against the state *before* the whole batch, or intermediate state *during* it. If it's the former (which I believe is correct, but can't confirm), that rule would break every legitimate booking, since the `bookings` doc wouldn't "exist yet" from the rule's point of view even though it's part of the same commit. Rather than ship something that might silently break all bookings, I went with the scan tool, which is correct and safe regardless of that batch-evaluation detail. If you want to pursue the stricter rule, test it in the Firebase Rules Playground first.

## 2. No server-side type/range/length validation (Medium) — Fixed

**The issue:** The original rules checked that the right *keys* were present on a new document, but not that the *values* made sense — a direct API call could set `customerName` to a number or an array, `startMinutes` to `-9999`, or `notes` to a 500KB string. None of this breaks your UI outright (everything is rendered with `.textContent` or an HTML-escaping helper, so it's not an XSS risk), but it's sloppy data hygiene and a mild storage/abuse vector.

**What I fixed:** The rules for creating a `bookings` document now require: `facility` is one of the three real facility names; `customerName` is a non-empty string under 100 characters; `startMinutes` is an integer between 0–1439; `durationMinutes` is an integer, at least 60, and a multiple of 30; `endMinutes` matches the arithmetic; `notes`, if present, is under 500 characters. Same idea applied to `slots` documents (valid facility name, `bookingId` must be a string).

## 3. Phone validation was client-side only (Medium) — Fixed

**The issue:** `index.html` validates the Bangladesh phone format (`01XXXXXXXXX` / `+8801XXXXXXXXX`) in JavaScript before enabling the submit button — good UX, but someone bypassing the page entirely could submit garbage.

**What I fixed:** The same regex now runs inside the Firestore rule itself (`phone.matches('^(\\+?880|0)1[3-9][0-9]{8}$')`), so a malformed phone number is rejected by the database regardless of what called it.

## 4. No abuse/spam protection on public writes (High) — Needs your action

This is the one I'd prioritize most after publishing the updated rules. Even with findings 1–3 fixed, there's nothing stopping an automated script from submitting hundreds of legitimate-*looking* pending booking requests per minute — real name-shaped strings, valid-format phone numbers, real facilities and time slots. Rules can validate *shape*, not *intent*. At volume, this could:
- Flood your admin dashboard, burying real customer requests.
- Temporarily lock out real customers from slots (since Pending slots aren't selectable) until you manually reject the spam.
- Run up your Firestore read/write usage (unlikely to hit real cost on the free tier at small scale, but worth knowing).

**What to do:** Enable **Firebase App Check** with reCAPTCHA v3 on your project (Firebase Console → App Check). This requires visitors' browsers to pass an invisible bot-check before writes are accepted, and is the standard mitigation for exactly this problem. It's a Console + a few lines of SDK setup — I can walk you through it or write the integration code if you want to proceed, but I can't turn it on for you since it needs your Firebase project access.

## 5. Web API key has no referrer restriction (Low) — Needs your action

Your Firebase `apiKey` is visible in both files' source — **this is normal and not a leak**; Firebase web API keys aren't secrets, they just identify your project, and your actual security boundary is the Firestore rules. That said, best practice is to restrict the key in Google Cloud Console (APIs & Services → Credentials → your key → Application restrictions → HTTP referrers) to only your GitHub Pages domain. This stops someone from copying your key into an unrelated site and riding on your project's quota. Low urgency, easy to do whenever convenient.

## 6. No multi-factor authentication on the admin account (Medium) — Needs your action

`admin.html`'s entire security model rests on one email/password pair. If that password is ever guessed, phished, or reused elsewhere, the attacker gets full read/write access to every customer's name, phone, and email, plus the ability to approve/reject/cancel any booking. Firebase's basic Authentication product doesn't offer MFA directly — you'd need to either upgrade to Google Cloud Identity Platform (adds MFA support, has its own pricing) or, more simply, just use a strong, unique password and enable "leaked password" protection under Authentication → Settings in the Firebase Console (free, one toggle). I'd treat the toggle as a minimum and the full MFA upgrade as optional given the scale of this project.

## 7. No monitoring on admin activity (Low) — Optional

There's currently no alerting if the admin account signs in from an unexpected location, or if write volume to `bookings`/`slots` spikes abnormally. For a single-venue system this is genuinely optional — Firebase Console's Authentication tab shows sign-in history if you ever want to spot-check it manually, and the orphan-scan tool doubles as an informal health check. Not worth automating unless this system grows.

---

## What "secure" means here, concretely

Two guarantees this system actually provides, worth restating since they're easy to take for granted:
- **Two customers can never be approved for the same half-hour**, even under concurrent requests — enforced by Firestore itself via the atomic batch + `!exists()` pattern, not by your JavaScript.
- **Customer phone numbers, emails, and notes are never readable by anyone except an authenticated admin** — enforced by rules, not by the UI simply not showing a button.

Everything in this report is about hardening *around* those two guarantees, not replacing them — the core conflict-prevention and privacy model was sound before this audit and remains the foundation.
