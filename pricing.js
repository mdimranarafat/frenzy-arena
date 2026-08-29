// pricing.js — single source of truth for Frenzy's facility list and booking pricing.
// Imported as a native ES module by both index.html (customer site) and admin.html
// (admin panel) — no bundler needed, consistent with the rest of this project's
// zero-build-tool architecture. Do not duplicate this logic inline in either file;
// import from here so customer-facing and admin-facing prices can never drift apart.

export const FACILITIES = ["sixASideTurf", "fourASideTurf", "swimmingPool", "carrom"];

export const FACILITY_LABELS = {
  sixASideTurf: "6A Side Turf",
  fourASideTurf: "4A Side Turf",
  swimmingPool: "Swimming Pool",
  carrom: "Carrom",
};

// 5:00 AM (slot 10) through 4:30 PM (slot 33) = DAY
// 5:00 PM (slot 34) through 11:30 PM (slot 47) = NIGHT
// 12:00 AM (slot 0) through 4:30 AM (slot 9)  = MIDNIGHT
// The brief's "12:01 AM" midnight-period boundary collapses to slot 0 here — there's no way to
// represent a 1-minute-past-midnight boundary on a 30-minute-slot grid, and the system's own
// selectable start times only ever land on :00 or :30, so slot 0 (12:00 AM) is the first actually
// bookable time in the MIDNIGHT period.
function timePeriod(startSlot) {
  if (startSlot >= 10 && startSlot < 34) return "day";
  if (startSlot >= 34) return "night";
  return "midnight";
}

// Thursday(4)/Friday(5)/Saturday(6) get the surcharge; Sunday(0)-Wednesday(3) don't.
// Same UTC-midnight date parsing already used by this project's addDays()/dayOfWeek() helpers in
// index.html and admin.html, so weekday determination never drifts from the rest of the app.
function isSurchargeDay(dateStr) {
  const day = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return day >= 4 && day <= 6;
}

// Published 60-minute and 90-minute base price per time period, Sunday-Wednesday, per turf.
// Only these two durations were specified. Any other duration (2h, 2.5h, 3h, ...) is extrapolated
// linearly: each additional 30-minute block beyond the first 60 minutes costs exactly the same as
// the 60->90 step did (price90 - price60). This is an assumption beyond what was explicitly
// specified in the brief — flagged in the accompanying summary, easy to change in one place here
// if the real pricing differs.
const TURF_BASE = {
  sixASideTurf: {
    day: { base60: 750, base90: 1150 },
    night: { base60: 1450, base90: 2200 },
    midnight: { base60: 1200, base90: 1400 },
  },
  fourASideTurf: {
    day: { base60: 500, base90: 750 },
    night: { base60: 1000, base90: 1200 },
    midnight: { base60: 900, base90: 1200 },
  },
};

// Swimming Pool and Carrom: flat hourly rate, every day, no day/night/midnight period distinction
// (the brief only specifies day/night/midnight periods for the two turf facilities).
const HOURLY_RATE = {
  swimmingPool: 200,
  carrom: 150,
};

function turfBasePrice(facility, startSlot, durationMinutes) {
  const period = timePeriod(startSlot);
  const table = TURF_BASE[facility][period];
  const incrementPer30Min = table.base90 - table.base60;
  const extraBlocksPast60Min = Math.max(0, (durationMinutes - 60) / 30);
  return { basePrice: table.base60 + extraBlocksPast60Min * incrementPer30Min, timePeriod: period };
}

function flatRateBasePrice(facility, durationMinutes) {
  return { basePrice: HOURLY_RATE[facility] * (durationMinutes / 60), timePeriod: null };
}

/**
 * The single pricing calculation used everywhere a price is shown or stored: the public booking
 * form, admin's New/Edit/Approve/Corporate flows, and the `calculatedPrice` snapshot stored on
 * every booking record. Price is always based on the booking's START time/date and full duration —
 * a booking that crosses midnight or crosses from Wednesday into Thursday is priced entirely by
 * its start, never split into per-period or per-date segments (preserving the existing
 * start-time-based pricing behavior the brief asked to keep).
 *
 * @param {{facility:string, bookingDate:string, startSlot:number, durationSlots:number}} args
 * @returns {{basePrice:number, finalPrice:number, timePeriod:(string|null), isSurchargeDay:boolean}}
 */
export function calculateBookingPrice({ facility, bookingDate, startSlot, durationSlots }) {
  const durationMinutes = durationSlots * 30;
  let result;
  if (facility === "swimmingPool" || facility === "carrom") {
    result = flatRateBasePrice(facility, durationMinutes);
  } else if (facility === "sixASideTurf" || facility === "fourASideTurf") {
    result = turfBasePrice(facility, startSlot, durationMinutes);
  } else {
    throw new Error(`calculateBookingPrice: unknown facility "${facility}"`);
  }

  const surcharge = isSurchargeDay(bookingDate);
  // The exact required formula, applied to the whole-duration base price — never Math.round(),
  // always floor to the nearest 100 after adding 25%.
  const finalPrice = surcharge ? Math.floor((result.basePrice * 1.25) / 100) * 100 : result.basePrice;

  return {
    basePrice: result.basePrice,
    finalPrice,
    timePeriod: result.timePeriod, // "day" | "night" | "midnight" | null (pool/carrom have no periods)
    isSurchargeDay: surcharge,
  };
}

// ---------------------------------------------------------------------------
// PAYMENT / DISCOUNT / INVOICE HELPERS
// New in this pass. These are intentionally NOT part of calculateBookingPrice() above — discount
// is an admin-applied adjustment on top of the calculated price, never a change to the pricing
// tables themselves, and payment tracking is orthogonal to pricing entirely. Kept here (rather
// than duplicated in index.html/admin.html) so invoice numbering and discount math can never
// drift between the customer site and the admin panel, same rationale as calculateBookingPrice.

/**
 * Deterministic, collision-free invoice number derived from the booking's own Firestore document
 * ID — never a sequential counter (which would be race-condition-prone under concurrent writes,
 * exactly what the brief said to avoid). Assign this ONCE, at booking-document-creation time (the
 * doc ref's .id is known before the write commits), for every booking regardless of source
 * (customer_request / admin_direct / corporate_recurring). Never regenerate it afterwards —
 * approving, editing, or repricing a booking must never change its invoice number.
 *
 * Format: FRZ-YYYYMMDD-XXXXXX (date = the booking's bookingDate, XXXXXX = last 6 chars of the doc
 * ID, uppercased). Two bookings on the same date can never collide because Firestore doc IDs are
 * globally unique; the suffix is just for human readability, not the uniqueness guarantee.
 *
 * @param {string} bookingDate - "YYYY-MM-DD"
 * @param {string} docId - the Firestore booking document's own id
 * @returns {string}
 */
export function makeInvoiceNumber(bookingDate, docId) {
  const compact = (bookingDate || "").replace(/-/g, "");
  const suffix = String(docId || "").slice(-6).toUpperCase().padStart(6, "0");
  return `FRZ-${compact}-${suffix}`;
}

/**
 * Net price after an admin-applied discount, floored at 0 (a discount can never make a booking
 * "owe" a negative amount). `discount` is a flat BDT amount, not a percentage — matches how the
 * admin panel's other money fields (bookingFee, calculatedPrice) already work.
 */
export function applyDiscount(calculatedPrice, discount) {
  const d = Number(discount) || 0;
  return Math.max(0, Number(calculatedPrice) - d);
}

/**
 * The customer's full total for a booking: discounted price + the separate optional booking fee.
 * Matches the existing admin-panel comment that "the Booking Fee is a separate, optional admin
 * override — it doesn't replace the calculated price."
 */
export function totalDue({ calculatedPrice, discount, bookingFee }) {
  return applyDiscount(calculatedPrice, discount) + (Number(bookingFee) || 0);
}

/**
 * Outstanding balance given what's been paid so far. Refunded bookings are treated as fully
 * settled (0 outstanding) regardless of paidAmount bookkeeping, since a refund closes the
 * financial loop on that booking.
 */
export function outstandingAmount({ calculatedPrice, discount, bookingFee, paidAmount, paymentStatus }) {
  if (paymentStatus === "refunded") return 0;
  const total = totalDue({ calculatedPrice, discount, bookingFee });
  return Math.max(0, total - (Number(paidAmount) || 0));
}

// Default payment fields for any booking document that predates this feature. Applied ONLY at
// read/display/export time (renderers and CSV export use `b.paymentStatus || 'unpaid'` etc.) —
// never backfilled as a write to old Firestore documents, so historical bookings are never
// touched. See PAYMENT_STATUSES for the fixed set of valid values used by the UI <select>s.
export const PAYMENT_STATUSES = ["unpaid", "partial", "paid", "refunded"];
export const PAYMENT_STATUS_LABELS = {
  unpaid: "Unpaid",
  partial: "Partial",
  paid: "Paid",
  refunded: "Refunded",
};
