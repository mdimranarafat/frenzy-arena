'use strict';

/**
 * Maps Frenzy Arena's actual Firestore `bookings/{id}` schema to a flat
 * row for the Google Sheets backup.
 *
 * IMPORTANT: this file intentionally mirrors ONLY fields that really exist
 * on the booking document today (verified against index.html / admin.html).
 * Two columns in the original spec have no equivalent in the app's data
 * model and are handled explicitly rather than guessed:
 *   - "Payment Status" / "Payment Amount": this app has no payment-collection
 *     tracking, only an admin-set `bookingFee`. Payment Amount mirrors
 *     bookingFee; Payment Status is left "N/A" (not applicable) unless you
 *     later add real payment tracking to the app.
 *   - "Approved By": not previously recorded. If you added the optional
 *     `approvedBy` field to admin.html's approve handler (see
 *     BACKUP_SETUP.md), it will show up here; otherwise it's blank.
 */

const FACILITY_LABELS = {
  futsalTurf: 'Futsal Turf',
  swimmingPool: 'Swimming Pool',
  carrom: 'Carrom',
};

const BOOKING_TYPE_LABELS = {
  customer_request: 'Customer',
  admin_direct: 'Admin Direct Booking',
  corporate_recurring: 'Corporate / Recurring Booking',
};

const STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

// Column order — row 1 of the sheet must match this exactly.
const HEADER_ROW = [
  'Booking ID',
  'Customer Name',
  'Customer Phone Number',
  'Customer Email',
  'Facility Name',
  'Booking Date',
  'Start Time',
  'End Time',
  'Duration',
  'Booking Status',
  'Payment Status',
  'Payment Amount',
  'Booking Fee',
  'Booking Type',
  'Created At',
  'Updated At',
  'Approved At',
  'Approved By',
  'Notes',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function minutesToLabel(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(mm)} ${h < 12 ? 'AM' : 'PM'}`;
}

function durationLabel(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} Hour${h > 1 ? 's' : ''}`);
  if (m > 0) parts.push(`${m} Minutes`);
  return parts.join(' ') || '0 Minutes';
}

// Adds `addDays` calendar days to a "YYYY-MM-DD" string, returns "YYYY-MM-DD".
function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  // Firestore Timestamp (Admin SDK) has .toDate(); guard for plain Date too.
  const date = typeof ts.toDate === 'function' ? ts.toDate() : ts;
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  return date.toISOString();
}

/**
 * @param {string} bookingId
 * @param {object} data - the booking document's data()
 * @returns {string[]} row values in HEADER_ROW order
 */
function mapBookingToRow(bookingId, data) {
  const startMinutes = Number.isFinite(data.startMinutes) ? data.startMinutes : null;
  const durationMinutes = Number.isFinite(data.durationMinutes) ? data.durationMinutes : null;

  let startTimeLabel = '';
  let endTimeLabel = '';
  if (startMinutes != null) {
    startTimeLabel = minutesToLabel(startMinutes);
    if (durationMinutes != null) {
      const endAbs = startMinutes + durationMinutes;
      const dayOffset = Math.floor(endAbs / 1440);
      const endMinInDay = ((endAbs % 1440) + 1440) % 1440;
      endTimeLabel =
        dayOffset > 0 && data.bookingDate
          ? `${minutesToLabel(endMinInDay)} (${addDaysStr(data.bookingDate, dayOffset)})`
          : minutesToLabel(endMinInDay);
    }
  }

  const facilityLabel = FACILITY_LABELS[data.facility] || data.facility || '';
  const bookingTypeLabel = BOOKING_TYPE_LABELS[data.bookingType] || data.bookingType || '';
  const statusLabel = STATUS_LABELS[data.status] || data.status || '';

  return [
    bookingId,
    data.customerName || '',
    data.phone || '',
    data.email || '',
    facilityLabel,
    data.bookingDate || '',
    startTimeLabel,
    endTimeLabel,
    durationMinutes != null ? durationLabel(durationMinutes) : '',
    statusLabel,
    'N/A', // Payment Status — no payment-tracking concept exists in this app today
    data.bookingFee != null ? data.bookingFee : '', // Payment Amount (mirrors bookingFee)
    data.bookingFee != null ? `${data.bookingFee} ${data.feeCurrency || ''}`.trim() : '',
    bookingTypeLabel,
    formatTimestamp(data.createdAt),
    formatTimestamp(data.updatedAt),
    formatTimestamp(data.approvedAt),
    data.approvedBy || '',
    data.notes || '',
  ];
}

module.exports = { HEADER_ROW, mapBookingToRow, FACILITY_LABELS, BOOKING_TYPE_LABELS, STATUS_LABELS };
