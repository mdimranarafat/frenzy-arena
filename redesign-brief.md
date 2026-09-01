# Frenzy Arena Admin Extension Brief

## Mode
Extension / preserve. The existing admin dashboard is the protected baseline; the requested billing and reporting capabilities are additive.

## Preserve
- Existing header navigation: `+ New Booking`, `+ Corporate / Recurring`, and `Log Out`.
- Existing booking views: `Pending Requests`, `All Bookings`, and `Recurring Bookings`.
- Existing filters, booking actions, pricing controls, Google Sheets mirror, and CSV download behavior.
- Existing Firestore collections, Firebase authentication gate, slot-locking model, and public booking flow.

## Improve
- Add payment fields without duplicating the canonical booking value: `calculatedPrice` remains the total booking amount; new aggregate fields are `paidAmount`, `paymentMethod`, and derived `paymentStatus`.
- Add compact payment visibility to booking rows, a reports panel, printable invoice preview, WhatsApp message action, and Excel-compatible export.
- Keep all payment math derived from total minus paid, with paid amount validation.

## Remove
- No existing controls or workflow elements are removed, renamed, hidden, or replaced.
- No discount section is introduced into invoices.

## Protected design system
- Colors: navy `#061a2b`, navy-mid `#0c2e47`, pool `#00b8d9`, turf `#1fa25c`, flare `#ff5a36`, paper `#f2f6f5`.
- Typography: Archivo Black for display headings, Manrope for body/UI, JetBrains Mono for compact status labels.
- Rhythm: existing 5/6/8/10/12/14/16/20/22px values and the current 1180px container.
- Shape: 5px form/button radius, 8px cards, 10px dark modal panels, restrained borders and no new shadow language.

## Highest-risk change
Firestore public-create field whitelists must accept only the new zero-payment fields; admin writes remain role-protected. Existing documents without payment fields must render as unpaid without migration.

## Rollback / fallback
Payment display derives safe defaults from `calculatedPrice` and `paidAmount`; if new fields are absent, old bookings remain readable and editable. Google Sheets sync remains best-effort after a successful local CSV/Excel download.
