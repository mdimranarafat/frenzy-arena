/**
 * Frenzy Sports Arena — Daily Google Sheets Backup
 * =================================================
 * Pulls every booking from Firestore and upserts it into this Sheet, once a day.
 * Firestore remains the single source of truth for live availability — this is a
 * read-only, append/update-only backup copy for reporting and disaster recovery.
 *
 * REQUIRED SETUP (do this before running anything):
 *   Apps Script Editor → Project Settings (gear icon) → Script Properties → add:
 *     FIREBASE_PROJECT_ID     = frenzy-arena
 *     SHEET_ID                = 18azspQLSNou19biZ_3NvWInGgRPdBMG6ImKyF91B0k0
 *     SERVICE_ACCOUNT_KEY     = <the full JSON key file content, as one line>
 *     ADMIN_ALERT_EMAIL       = mdimran3067333@gmail.com   (optional — for failure emails)
 *
 *   Never paste the service account key directly into this file — Script Properties
 *   are stored separately from the code and are not included if you ever export or
 *   share this script's source.
 *
 * FUNCTIONS:
 *   dailyBackup()        — the main sync. Safe to run manually or via trigger, any number of times.
 *   manualBackupTest()   — same as dailyBackup(), but shows a popup summary (run this from the editor).
 *   createDailyTrigger() — installs the once-a-day automatic trigger (run this once, manually).
 */

var BOOKINGS_SHEET_NAME = 'Bookings';
var LOG_SHEET_NAME = 'Backup Log';

var BOOKINGS_HEADER = [
  'Booking ID', 'Customer Name', 'Phone', 'Email', 'Facility', 'Booking Date',
  'Start Time', 'End Time', 'Duration', 'Status', 'Booking Type', 'Booking Source',
  'Booking Fee', 'Fee Currency', 'Fee Shown Publicly', 'Recurring Series ID', 'Notes',
  'Created At', 'Updated At', 'Approved At', 'Rejected At', 'Last Backed Up At',
];

var FACILITY_LABELS = { futsalTurf: 'Futsal Turf', swimmingPool: 'Swimming Pool', carrom: 'Carrom' };

// ---------------------------------------------------------------------------
// ENTRY POINTS
// ---------------------------------------------------------------------------

function dailyBackup() {
  var startedAt = new Date();
  var result = { total: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

  try {
    var config = getConfig_();
    var accessToken = getAccessToken_(config);
    var bookings = listAllBookings_(config.projectId, accessToken);
    result.total = bookings.length;

    var ss = SpreadsheetApp.openById(config.sheetId);
    var sheet = getOrCreateSheet_(ss, BOOKINGS_SHEET_NAME, BOOKINGS_HEADER);
    var upsertSummary = upsertBookingRows_(sheet, bookings);
    result.inserted = upsertSummary.inserted;
    result.updated = upsertSummary.updated;
    result.failed = upsertSummary.failed;
    result.errors = upsertSummary.errors;

    logRun_(ss, startedAt, result, null);

    if (result.failed > 0) {
      maybeSendAlertEmail_(config, 'Frenzy backup completed with ' + result.failed + ' row error(s)', result);
    }
  } catch (err) {
    result.errors.push(String(err && err.message ? err.message : err));
    try {
      var config2 = getConfig_();
      var ss2 = SpreadsheetApp.openById(config2.sheetId);
      logRun_(ss2, startedAt, result, err);
      maybeSendAlertEmail_(config2, 'Frenzy backup FAILED', result);
    } catch (loggingErr) {
      // If we can't even open the Sheet to log the failure, surface it in the execution log —
      // this is the only case where a temporary Sheets outage could hide a backup failure.
      console.error('Backup failed AND could not write to the log sheet:', loggingErr);
    }
    throw err; // still surface it in the Apps Script execution log / trigger history
  }

  return result;
}

function manualBackupTest() {
  var result = dailyBackup();
  var summary =
    'Total bookings: ' + result.total + '\n' +
    'Inserted: ' + result.inserted + '\n' +
    'Updated: ' + result.updated + '\n' +
    'Failed: ' + result.failed +
    (result.errors.length ? '\n\nFirst error:\n' + result.errors[0] : '');
  SpreadsheetApp.getUi().alert('Frenzy Backup — Manual Test', summary, SpreadsheetApp.getUi().ButtonSet.OK);
}

function createDailyTrigger() {
  // Idempotent — clears any existing triggers for dailyBackup before adding a fresh one,
  // so running this more than once never creates duplicate triggers.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyBackup') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('dailyBackup')
    .timeBased()
    .atHour(3) // 3 AM in the script's timezone (Apps Script → Project Settings → Time zone; set this to Asia/Dhaka)
    .everyDays(1)
    .create();
  SpreadsheetApp.getUi().alert('Daily backup trigger installed — runs once a day around 3 AM.');
}

// ---------------------------------------------------------------------------
// CONFIG & AUTH
// ---------------------------------------------------------------------------

function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var projectId = props.getProperty('FIREBASE_PROJECT_ID');
  var sheetId = props.getProperty('SHEET_ID');
  var keyJson = props.getProperty('SERVICE_ACCOUNT_KEY');
  var alertEmail = props.getProperty('ADMIN_ALERT_EMAIL');

  if (!projectId || !sheetId || !keyJson) {
    throw new Error(
      'Missing Script Properties. Go to Project Settings → Script Properties and set ' +
      'FIREBASE_PROJECT_ID, SHEET_ID, and SERVICE_ACCOUNT_KEY.'
    );
  }
  var serviceAccount;
  try {
    serviceAccount = JSON.parse(keyJson);
  } catch (e) {
    throw new Error('SERVICE_ACCOUNT_KEY is not valid JSON — paste the full key file content as one line.');
  }
  return { projectId: projectId, sheetId: sheetId, serviceAccount: serviceAccount, alertEmail: alertEmail || null };
}

// Signs a JWT with the service account's private key and exchanges it for a short-lived
// OAuth2 access token — no external libraries, uses Apps Script's built-in RSA signing.
function getAccessToken_(config) {
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claimSet = {
    iss: config.serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  var encodedHeader = base64UrlEncode_(JSON.stringify(header));
  var encodedClaimSet = base64UrlEncode_(JSON.stringify(claimSet));
  var signatureInput = encodedHeader + '.' + encodedClaimSet;

  var signatureBytes = Utilities.computeRsaSha256Signature(signatureInput, config.serviceAccount.private_key);
  var encodedSignature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  var jwt = signatureInput + '.' + encodedSignature;

  var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  var result = JSON.parse(response.getContentText());
  if (!result.access_token) {
    throw new Error('Could not get an access token — check the service account key. Response: ' + response.getContentText());
  }
  return result.access_token;
}

function base64UrlEncode_(str) {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(str).getBytes()).replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// FIRESTORE REST API
// ---------------------------------------------------------------------------

function listAllBookings_(projectId, accessToken) {
  var bookings = [];
  var pageToken = null;
  var baseUrl = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/bookings';

  do {
    var url = baseUrl + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code !== 200) {
      throw new Error('Firestore list request failed (HTTP ' + code + '): ' + response.getContentText());
    }
    var body = JSON.parse(response.getContentText());
    (body.documents || []).forEach(function (doc) {
      var nameParts = doc.name.split('/');
      var id = nameParts[nameParts.length - 1];
      bookings.push({ id: id, data: firestoreDocToJs_(doc.fields || {}) });
    });
    pageToken = body.nextPageToken || null;
  } while (pageToken);

  return bookings;
}

// Unwraps Firestore's REST API value format ({stringValue: "..."}, {integerValue: "5"}, etc.)
// into plain JS values. Handles the field types this app's booking documents actually use.
function firestoreValueToJs_(value) {
  if (value == null) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue; // ISO 8601 string
  if ('mapValue' in value) return firestoreDocToJs_(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValueToJs_);
  return null;
}
function firestoreDocToJs_(fields) {
  var out = {};
  Object.keys(fields).forEach(function (key) {
    out[key] = firestoreValueToJs_(fields[key]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// FORMATTING (mirrors the web app's conventions)
// ---------------------------------------------------------------------------

function minutesToLabel_(min) {
  min = ((min % 1440) + 1440) % 1440;
  var h = Math.floor(min / 60), m = min % 60;
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + (m < 10 ? '0' + m : m) + ' ' + (h < 12 ? 'AM' : 'PM');
}
function durationLabel_(totalMinutes) {
  var h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
  var parts = [];
  if (h > 0) parts.push(h + ' Hour' + (h > 1 ? 's' : ''));
  if (m > 0) parts.push(m + ' Minutes');
  return parts.join(' ') || '0 Minutes';
}
function fmtIsoTimestamp_(iso) {
  if (!iso) return '';
  return Utilities.formatDate(new Date(iso), 'Asia/Dhaka', 'yyyy-MM-dd HH:mm');
}

function bookingToRow_(id, data) {
  var endLabel = data.endMinutes != null ? minutesToLabel_(data.endMinutes) : '';
  if (data.endMinutes != null && data.endMinutes >= 1440) endLabel += ' (+1d)';
  return [
    id,
    data.customerName || '',
    data.phone || '',
    data.email || '',
    FACILITY_LABELS[data.facility] || data.facility || '',
    data.bookingDate || '',
    data.startMinutes != null ? minutesToLabel_(data.startMinutes) : '',
    endLabel,
    data.durationMinutes != null ? durationLabel_(data.durationMinutes) : '',
    data.status || '',
    (data.bookingType || '').replace('_', ' '),
    data.bookingSource || '',
    data.bookingFee != null ? data.bookingFee : '',
    data.feeCurrency || '',
    data.showFeePublicly ? 'Yes' : 'No',
    data.recurringBookingId || '',
    data.notes || '',
    fmtIsoTimestamp_(data.createdAt),
    fmtIsoTimestamp_(data.updatedAt),
    fmtIsoTimestamp_(data.approvedAt),
    fmtIsoTimestamp_(data.rejectedAt),
    Utilities.formatDate(new Date(), 'Asia/Dhaka', 'yyyy-MM-dd HH:mm'),
  ];
}

// ---------------------------------------------------------------------------
// SHEET WRITE (upsert by Booking ID — idempotent, no duplicate rows)
// ---------------------------------------------------------------------------

function getOrCreateSheet_(ss, name, header) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  var firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  var hasHeader = firstRow.some(function (v) { return v !== ''; });
  if (!hasHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function upsertBookingRows_(sheet, bookings) {
  var lastRow = sheet.getLastRow();
  var idToRow = {};
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0]) idToRow[ids[i][0]] = i + 2; // +2: 1-indexed, plus header row
    }
  }

  var inserted = 0, updated = 0, failed = 0, errors = [];
  var rowsToAppend = [];

  bookings.forEach(function (b) {
    try {
      var row = bookingToRow_(b.id, b.data);
      var existingRow = idToRow[b.id];
      if (existingRow) {
        sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
        updated++;
      } else {
        rowsToAppend.push(row);
        inserted++;
      }
    } catch (err) {
      failed++;
      errors.push('Booking ' + b.id + ': ' + (err && err.message ? err.message : err));
    }
  });

  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, BOOKINGS_HEADER.length).setValues(rowsToAppend);
  }

  return { inserted: inserted, updated: updated, failed: failed, errors: errors.slice(0, 20) };
}

// ---------------------------------------------------------------------------
// LOGGING & ALERTS
// ---------------------------------------------------------------------------

function logRun_(ss, startedAt, result, thrownError) {
  var logSheet = getOrCreateSheet_(ss, LOG_SHEET_NAME, ['Run At', 'Duration (s)', 'Total', 'Inserted', 'Updated', 'Failed', 'Errors']);
  var durationSec = Math.round((new Date() - startedAt) / 1000);
  var errorText = result.errors.join(' | ') + (thrownError ? (' | FATAL: ' + (thrownError.message || thrownError)) : '');
  logSheet.appendRow([
    Utilities.formatDate(new Date(), 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'),
    durationSec,
    result.total,
    result.inserted,
    result.updated,
    result.failed,
    errorText,
  ]);
}

function maybeSendAlertEmail_(config, subject, result) {
  if (!config.alertEmail) return;
  try {
    MailApp.sendEmail({
      to: config.alertEmail,
      subject: subject,
      body:
        'Frenzy Sports Arena backup summary:\n\n' +
        'Total: ' + result.total + '\n' +
        'Inserted: ' + result.inserted + '\n' +
        'Updated: ' + result.updated + '\n' +
        'Failed: ' + result.failed + '\n\n' +
        (result.errors.length ? 'Errors:\n' + result.errors.join('\n') : 'No errors.') +
        '\n\nCheck the "Backup Log" tab in the Sheet for full history.',
    });
  } catch (e) {
    // Email failing shouldn't fail the backup itself — it's already logged in the Sheet.
    console.error('Could not send alert email:', e);
  }
}
