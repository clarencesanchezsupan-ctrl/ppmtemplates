const PPM = {
  BOOKINGS_SHEET: 'Bookings',
  TEMPLATES_SHEET: 'Templates',
  SETTINGS_SHEET: 'Settings',
  PREVIEW_REQUESTS_SHEET: 'Preview Requests',
  TIMEZONE: 'Asia/Manila',
  PRICE: 200,
  RECEIPT_MAX_BYTES: 5 * 1024 * 1024,
  RECEIPT_TYPES: ['image/jpeg', 'image/png', 'image/webp']
};

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'PPM backend' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * JSON API used by the Netlify frontend through the private Netlify proxy.
 * Deploy the Apps Script web app as Execute as: Me / Who has access: Anyone.
 * Customers never see or open this URL directly.
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('PPM_PROXY_SECRET');
    if (!expectedSecret) throw new Error('Netlify proxy secret has not been generated yet.');
    if (!body.secret || body.secret !== expectedSecret) throw new Error('Unauthorized request.');

    let result;
    switch (String(body.action || '').trim()) {
      case 'config':
        result = getPublicConfig();
        break;
      case 'preview':
        result = sendFullPreviewRequest(body.email, body.templateId);
        break;
      case 'booking':
        result = submitBookingFromApi_(body);
        break;
      case 'health':
        result = { status: 'ok', service: 'PPM backend' };
        break;
      default:
        throw new Error('Unknown API action.');
    }
    return jsonOutput_({ ok: true, result: result });
  } catch (err) {
    console.error('PPM API error: ' + (err && err.stack ? err.stack : err));
    return jsonOutput_({ ok: false, error: err && err.message ? err.message : 'Server error.' });
  }
}

function submitBookingFromApi_(body) {
  if (!body || !body.receipt) throw new Error('Please upload your payment receipt.');
  const receipt = body.receipt;
  const type = clean_(receipt.type, 80).toLowerCase();
  if (!PPM.RECEIPT_TYPES.includes(type)) throw new Error('Receipt must be JPG, PNG, or WEBP.');

  const raw = String(receipt.data || '').replace(/^data:[^,]+,/, '');
  if (!raw) throw new Error('Receipt image is empty.');

  let bytes;
  try {
    bytes = Utilities.base64Decode(raw);
  } catch (err) {
    throw new Error('Receipt image could not be decoded.');
  }
  if (bytes.length > PPM.RECEIPT_MAX_BYTES) throw new Error('Receipt image must be 5 MB or smaller.');

  const name = sanitizeFilename_(receipt.name || 'receipt.jpg');
  const blob = Utilities.newBlob(bytes, type, name);
  return submitBooking({
    clientName: body.clientName,
    email: body.email,
    templateId: body.templateId,
    notes: body.notes || '',
    receipt: blob
  });
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run ONCE. Copy the logged secret into Netlify as PPM_PROXY_SECRET. */
function generateNetlifyProxySecret() {
  const secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('PPM_PROXY_SECRET', secret);
  console.log('PPM_PROXY_SECRET=' + secret);
  return secret;
}


/**
 * Run this ONCE from the new PPM business Gmail account.
 * It creates the database, receipt folder, settings, template catalog,
 * and the installable edit trigger that sends template links after confirmation.
 */
function setupPPMStore() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const existingId = props.getProperty('PPM_STORE_SPREADSHEET_ID');

  if (existingId) {
    ss = SpreadsheetApp.openById(existingId);
  } else {
    ss = SpreadsheetApp.create('PPM Template Store');
    props.setProperty('PPM_STORE_SPREADSHEET_ID', ss.getId());
  }

  setupBookingsSheet_(ss);
  setupTemplatesSheet_(ss);
  setupSettingsSheet_(ss);
  setupPreviewRequestsSheet_(ss);
  ensureReceiptFolder_();
  ensureAdminEditTrigger_(ss);

  const settings = getSettings_();
  return {
    spreadsheetUrl: ss.getUrl(),
    receiptFolderUrl: DriveApp.getFolderById(props.getProperty('PPM_RECEIPT_FOLDER_ID')).getUrl(),
    ownerEmail: settings.OWNER_EMAIL || '',
    message: 'PPM Template Store setup is complete.'
  };
}

function setupBookingsSheet_(ss) {
  let sheet = ss.getSheetByName(PPM.BOOKINGS_SHEET);
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName(PPM.BOOKINGS_SHEET);
  }

  const headers = [
    'Timestamp',
    'Booking ID',
    'Client Name',
    'Email',
    'Template ID',
    'Template Name',
    'Price',
    'Receipt File',
    'Receipt URL',
    'Customer Notes',
    'Payment Status',
    'Template Link',
    'Template Sent',
    'Sent At',
    'Delivery Status'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setWrap(true);
  sheet.setColumnWidths(1, headers.length, 150);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 220);
  sheet.setColumnWidth(8, 220);
  sheet.setColumnWidth(9, 260);
  sheet.setColumnWidth(10, 280);
  sheet.setColumnWidth(12, 300);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Payment for Verification', 'Confirmed', 'Rejected', 'Refunded'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('K2:K').setDataValidation(statusRule);
}

function setupTemplatesSheet_(ss) {
  let sheet = ss.getSheetByName(PPM.TEMPLATES_SHEET);
  if (!sheet) sheet = ss.insertSheet(PPM.TEMPLATES_SHEET);

  // Preview Link is column G so the existing Delivery Link and Active columns stay unchanged.
  const headers = ['Template ID', 'Template Name', 'Collection', 'Price', 'Delivery Link', 'Active', 'Preview Link'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange('A1:G1').setFontWeight('bold');

  const defaults = [
    ['black-v1', 'Black V1', 'Black', 200, '', 'YES', ''],
    ['black-v2', 'Black V2', 'Black', 200, '', 'YES', ''],
    ['black-v3', 'Black V3', 'Black', 200, '', 'YES', ''],
    ['blush-pink-v1', 'Blush Pink V1', 'Blush Pink', 200, '', 'YES', ''],
    ['blush-pink-v2', 'Blush Pink V2', 'Blush Pink', 200, '', 'YES', ''],
    ['blush-pink-v3', 'Blush Pink V3', 'Blush Pink', 200, '', 'YES', ''],
    ['burgundy-v1', 'Burgundy V1', 'Burgundy', 200, '', 'YES', ''],
    ['burgundy-v2', 'Burgundy V2', 'Burgundy', 200, '', 'YES', ''],
    ['burgundy-v3', 'Burgundy V3', 'Burgundy', 200, '', 'YES', ''],
    ['pastel-canvas-v1', 'Pastel Canvas V1', 'Pastel Canvas', 200, '', 'YES', ''],
    ['pastel-canvas-v2', 'Pastel Canvas V2', 'Pastel Canvas', 200, '', 'YES', ''],
    ['pastel-canvas-v3', 'Pastel Canvas V3', 'Pastel Canvas', 200, '', 'YES', ''],
    ['hot-air-balloon', 'Hot Air Balloon', 'First Birthday / Christening', 100, '', 'YES', ''],
    ['fairy-1', 'Fairy 1', 'First Birthday / Christening', 100, '', 'YES', ''],
    ['fairy-2', 'Fairy 2', 'First Birthday / Christening', 100, '', 'YES', '']
  ];

  const existing = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues().forEach((r, i) => {
      if (r[0]) existing[String(r[0]).trim()] = { row: i + 2, values: r };
    });
  }

  defaults.forEach(row => {
    const id = row[0];
    if (existing[id]) {
      const n = existing[id].row;
      const currentLink = sheet.getRange(n, 5).getValue();
      const currentActive = sheet.getRange(n, 6).getValue();
      const currentPreview = sheet.getRange(n, 7).getValue();
      sheet.getRange(n, 1, 1, 4).setValues([[row[0], row[1], row[2], row[3]]]);
      if (currentLink === '') sheet.getRange(n, 5).setValue(row[4]);
      if (currentActive === '') sheet.getRange(n, 6).setValue(row[5]);
      if (currentPreview === '') sheet.getRange(n, 7).setValue(row[6]);
    } else {
      sheet.appendRow(row);
    }
  });

  sheet.autoResizeColumns(1, 7);
  sheet.setColumnWidth(5, 360);
  sheet.setColumnWidth(7, 360);
}

function setupPreviewRequestsSheet_(ss) {
  let sheet = ss.getSheetByName(PPM.PREVIEW_REQUESTS_SHEET);
  if (!sheet) sheet = ss.insertSheet(PPM.PREVIEW_REQUESTS_SHEET);

  const headers = ['Date', 'Email', 'Template', 'Status'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange('A1:D1').setFontWeight('bold');
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 220);
}

/** Run this once after updating to the preview-request feature. */
function setupPreviewRequestFeature() {
  const ss = getStoreSpreadsheet_();
  setupTemplatesSheet_(ss);
  setupPreviewRequestsSheet_(ss);
  return 'Preview request feature is ready. Add each full preview URL in Templates column G (Preview Link).';
}

/** Run this ONCE after installing V7 to add the new templates without resetting bookings or links. */
function syncTemplateCatalog() {
  const ss = getStoreSpreadsheet_();
  setupTemplatesSheet_(ss);
  return 'Template catalog synced. New Wedding and First Birthday / Christening templates are now in the Templates sheet.';
}

function setupSettingsSheet_(ss) {
  let sheet = ss.getSheetByName(PPM.SETTINGS_SHEET);
  if (!sheet) sheet = ss.insertSheet(PPM.SETTINGS_SHEET);

  sheet.getRange(1, 1, 1, 3).setValues([['SETTING', 'VALUE', 'NOTES']]);
  sheet.getRange('A1:C1').setFontWeight('bold');
  sheet.setFrozenRows(1);

  const defaults = [
    ['BRAND_NAME', 'Paanyaya Paper & Motion', 'Public brand name'],
    ['OWNER_EMAIL', Session.getEffectiveUser().getEmail() || '', 'Receives new-order notices'],
    ['FACEBOOK_URL', 'https://www.facebook.com/PaanyayaPM', 'Used by Request for full Preview and Custom Designs'],
    ['QR_DRIVE_URL', '', 'Paste the Google Drive URL of your QR Ph / GCash QR image here'],
    ['PAYMENT_INSTRUCTION', 'Pay the exact amount shown for your selected template, then upload your payment receipt.', 'Shown in the payment section'],
    ['CONFIRMATION_MESSAGE', 'Payment received. We will verify your receipt and email your template after confirmation.', 'Shown after submission']
  ];

  const existing = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach((r, i) => {
      if (r[0]) existing[String(r[0]).trim()] = i + 2;
    });
  }

  defaults.forEach(([key, value, note]) => {
    if (existing[key]) {
      const r = existing[key];
      if (sheet.getRange(r, 2).getValue() === '') sheet.getRange(r, 2).setValue(value);
      sheet.getRange(r, 3).setValue(note);
    } else {
      sheet.appendRow([key, value, note]);
    }
  });

  sheet.autoResizeColumns(1, 3);
  sheet.setColumnWidth(2, 420);
  sheet.setColumnWidth(3, 420);
}

function getPublicConfig() {
  const settings = getSettings_();
  const templates = getTemplates_().filter(t => t.active);
  let qrImage = '';

  if (settings.QR_DRIVE_URL) {
    try {
      qrImage = driveImageDataUrl_(settings.QR_DRIVE_URL);
    } catch (err) {
      console.error('QR image could not be loaded: ' + err.message);
    }
  }

  return {
    brandName: settings.BRAND_NAME || 'Paanyaya Paper & Motion',
    facebookUrl: settings.FACEBOOK_URL || '',
    qrImage,
    paymentInstruction: settings.PAYMENT_INSTRUCTION || '',
    confirmationMessage: settings.CONFIRMATION_MESSAGE || '',
    templates: templates.map(t => ({
      id: t.id,
      name: t.name,
      collection: t.collection,
      price: t.price
    }))
  };
}

/**
 * Receives the entire HTML form. The receipt file-input arrives as a Blob.
 */
function submitBooking(form) {
  if (!form) throw new Error('No booking data received.');

  const clientName = clean_(form.clientName, 120);
  const email = clean_(form.email, 200).toLowerCase();
  const templateId = clean_(form.templateId, 80);
  const notes = clean_(form.notes, 2000);

  if (!clientName) throw new Error('Please enter your name.');
  if (!isEmail_(email)) throw new Error('Please enter a valid email address.');

  const template = getTemplates_().find(t => t.id === templateId && t.active);
  if (!template) throw new Error('Please select an available template.');

  const receipt = form.receipt;
  validateReceipt_(receipt);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const bookingId = createBookingId_();
    const receiptFolder = DriveApp.getFolderById(ensureReceiptFolder_());
    const safeOriginalName = sanitizeFilename_(receipt.getName() || 'receipt.jpg');
    const savedReceipt = receiptFolder.createFile(receipt).setName(`${bookingId}_${safeOriginalName}`);

    // Receipt files remain private in the business Drive by default.
    const ss = getStoreSpreadsheet_();
    const sheet = ss.getSheetByName(PPM.BOOKINGS_SHEET);
    sheet.appendRow([
      new Date(),
      bookingId,
      clientName,
      email,
      template.id,
      template.name,
      template.price,
      savedReceipt.getName(),
      savedReceipt.getUrl(),
      notes,
      'Payment for Verification',
      '',
      'NO',
      '',
      'WAITING FOR PAYMENT VERIFICATION'
    ]);

    try {
      sendCustomerVerificationEmail_(clientName, email, bookingId, template);
    } catch (err) {
      console.error('Customer verification email failed: ' + err.message);
    }

    try {
      sendOwnerOrderNotice_(bookingId, clientName, email, template, savedReceipt.getUrl(), notes);
    } catch (err) {
      console.error('Owner notice failed: ' + err.message);
    }

    const settings = getSettings_();
    return {
      success: true,
      bookingId,
      templateName: template.name,
      price: template.price,
      status: 'Payment for Verification',
      message: settings.CONFIRMATION_MESSAGE || 'Payment received for verification.'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * INSTALLABLE on-edit trigger. Do not run manually.
 * - When a Booking is changed to Confirmed, send its template link.
 * - When a Delivery Link is added/changed in Templates, fulfill any matching confirmed orders.
 */
function handleAdminEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const ss = sheet.getParent();
  const storeId = PropertiesService.getScriptProperties().getProperty('PPM_STORE_SPREADSHEET_ID');
  if (!storeId || ss.getId() !== storeId) return;

  if (sheet.getName() === PPM.BOOKINGS_SHEET) {
    const headers = headerMap_(sheet);
    if (e.range.getRow() < 2) return;
    if (e.range.getColumn() !== headers['Payment Status']) return;

    const newStatus = String(e.value || '').trim();

    if (newStatus === 'Confirmed') {
      tryDeliverBooking_(sheet, e.range.getRow());
    } else if (newStatus === 'Rejected') {
      notifyRejectedBooking_(sheet, e.range.getRow());
    }
    return;
  }

  if (sheet.getName() === PPM.TEMPLATES_SHEET) {
    const headers = headerMap_(sheet);
    if (e.range.getRow() < 2) return;
    if (e.range.getColumn() === headers['Delivery Link']) {
      const templateId = String(sheet.getRange(e.range.getRow(), headers['Template ID']).getValue() || '').trim();
      if (templateId) sendPendingForTemplate_(templateId);
    }
  }
}

function sendPendingTemplateLinks() {
  const ss = getStoreSpreadsheet_();
  const sheet = ss.getSheetByName(PPM.BOOKINGS_SHEET);
  if (sheet.getLastRow() < 2) return 'No bookings found.';

  let sent = 0;
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    if (tryDeliverBooking_(sheet, row)) sent++;
  }
  return `Sent ${sent} pending template link(s).`;
}

function tryDeliverBooking_(sheet, row) {
  const headers = headerMap_(sheet);
  const paymentStatus = String(sheet.getRange(row, headers['Payment Status']).getValue() || '').trim();
  const alreadySent = String(sheet.getRange(row, headers['Template Sent']).getValue() || '').trim().toUpperCase();

  if (paymentStatus !== 'Confirmed' || alreadySent === 'YES') return false;

  const templateId = String(sheet.getRange(row, headers['Template ID']).getValue() || '').trim();
  const template = getTemplates_().find(t => t.id === templateId);

  if (!template || !template.deliveryLink) {
    sheet.getRange(row, headers['Delivery Status']).setValue('WAITING FOR TEMPLATE LINK');
    return false;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sentAgain = String(sheet.getRange(row, headers['Template Sent']).getValue() || '').trim().toUpperCase();
    if (sentAgain === 'YES') return false;

    const clientName = String(sheet.getRange(row, headers['Client Name']).getValue() || '').trim();
    const email = String(sheet.getRange(row, headers['Email']).getValue() || '').trim();
    const bookingId = String(sheet.getRange(row, headers['Booking ID']).getValue() || '').trim();

    sendTemplateDeliveryEmail_(clientName, email, bookingId, template);

    sheet.getRange(row, headers['Template Link']).setValue(template.deliveryLink);
    sheet.getRange(row, headers['Template Sent']).setValue('YES');
    sheet.getRange(row, headers['Sent At']).setValue(new Date());
    sheet.getRange(row, headers['Delivery Status']).setValue('SENT');
    return true;
  } finally {
    lock.releaseLock();
  }
}

function sendPendingForTemplate_(templateId) {
  const ss = getStoreSpreadsheet_();
  const sheet = ss.getSheetByName(PPM.BOOKINGS_SHEET);
  if (sheet.getLastRow() < 2) return;
  const headers = headerMap_(sheet);

  for (let row = 2; row <= sheet.getLastRow(); row++) {
    const rowTemplateId = String(sheet.getRange(row, headers['Template ID']).getValue() || '').trim();
    if (rowTemplateId === templateId) tryDeliverBooking_(sheet, row);
  }
}

function notifyRejectedBooking_(sheet, row) {
  const headers = headerMap_(sheet);
  const email = String(sheet.getRange(row, headers['Email']).getValue() || '').trim();
  const clientName = String(sheet.getRange(row, headers['Client Name']).getValue() || '').trim();
  const bookingId = String(sheet.getRange(row, headers['Booking ID']).getValue() || '').trim();
  const templateName = String(sheet.getRange(row, headers['Template Name']).getValue() || '').trim();
  const price = String(sheet.getRange(row, headers['Price']).getValue() || '').trim();

  if (!isEmail_(email)) {
    if (headers['Delivery Status']) {
      sheet.getRange(row, headers['Delivery Status']).setValue('REJECTED — INVALID CUSTOMER EMAIL');
    }
    return false;
  }

  sendPaymentRejectedEmail_(clientName, email, bookingId, templateName, price);

  if (headers['Delivery Status']) {
    sheet.getRange(row, headers['Delivery Status']).setValue('PAYMENT REJECTED — CUSTOMER NOTIFIED');
  }
  return true;
}

function sendPaymentRejectedEmail_(clientName, email, bookingId, templateName, price) {
  const safeName = clientName || 'there';
  const subject = `PPM Payment Verification Update — ${bookingId}`;
  const body = `Hi ${safeName},

We were unable to verify the payment receipt for your PPM order.

Booking ID: ${bookingId}
Template: ${templateName}
Amount: ₱${price}
Status: Payment Rejected

Please check the payment or receipt details and submit a valid receipt again, or contact Paanyaya Paper & Motion for assistance.

Thank you,
Paanyaya Paper & Motion`;
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#211d19;line-height:1.6">
      <p style="font-size:12px;letter-spacing:2px;text-transform:uppercase">Paanyaya Paper & Motion</p>
      <h2>We couldn't verify your payment.</h2>
      <p>Hi ${escapeHtml_(safeName)},</p>
      <p>We were unable to verify the payment receipt for your PPM order.</p>
      <div style="padding:18px;border:1px solid #ddd2c6;border-radius:14px;margin:20px 0">
        <strong>Booking ID:</strong> ${escapeHtml_(bookingId)}<br>
        <strong>Template:</strong> ${escapeHtml_(templateName)}<br>
        <strong>Amount:</strong> ₱${escapeHtml_(price)}<br>
        <strong>Status:</strong> Payment Rejected
      </div>
      <p>Please check the payment or receipt details and submit a valid receipt again, or contact Paanyaya Paper & Motion for assistance.</p>
      <p>Thank you,<br>Paanyaya Paper & Motion</p>
    </div>`;

  MailApp.sendEmail({ to: email, subject, body, htmlBody, name: 'Paanyaya Paper & Motion' });
}

function sendCustomerVerificationEmail_(clientName, email, bookingId, template) {
  const subject = `PPM Payment Received — ${bookingId}`;
  const body = `Hi ${clientName},\n\nWe received your payment receipt for ${template.name}.\n\nBooking ID: ${bookingId}\nAmount: ₱${template.price}\nStatus: Payment for Verification\n\nWe will email your template link after your payment is confirmed.\n\nPaanyaya Paper & Motion`;
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#211d19;line-height:1.6">
      <p style="font-size:12px;letter-spacing:2px;text-transform:uppercase">Paanyaya Paper & Motion</p>
      <h2>Payment receipt received</h2>
      <p>Hi ${escapeHtml_(clientName)},</p>
      <p>We received your payment receipt for <strong>${escapeHtml_(template.name)}</strong>.</p>
      <div style="padding:18px;border:1px solid #ddd2c6;border-radius:14px;margin:20px 0">
        <strong>Booking ID:</strong> ${escapeHtml_(bookingId)}<br>
        <strong>Amount:</strong> ₱${template.price}<br>
        <strong>Status:</strong> Payment for Verification
      </div>
      <p>We’ll email your template link after your payment is confirmed.</p>
      <p>Thank you,<br>Paanyaya Paper & Motion</p>
    </div>`;

  MailApp.sendEmail({ to: email, subject, body, htmlBody, name: 'Paanyaya Paper & Motion' });
}

function sendTemplateDeliveryEmail_(clientName, email, bookingId, template) {
  if (!isEmail_(email)) throw new Error('Customer email is invalid.');
  const subject = `Your PPM Template is Ready — ${template.name}`;
  const body = `Hi ${clientName},\n\nYour payment has been confirmed.\n\nBooking ID: ${bookingId}\nTemplate: ${template.name}\n\nOpen your template:\n${template.deliveryLink}\n\nThank you for choosing Paanyaya Paper & Motion.`;
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#211d19;line-height:1.6">
      <p style="font-size:12px;letter-spacing:2px;text-transform:uppercase">Paanyaya Paper & Motion</p>
      <h2>Your template is ready.</h2>
      <p>Hi ${escapeHtml_(clientName)},</p>
      <p>Your payment has been confirmed. You can now access <strong>${escapeHtml_(template.name)}</strong>.</p>
      <p><strong>Booking ID:</strong> ${escapeHtml_(bookingId)}</p>
      <p style="margin:28px 0">
        <a href="${escapeHtml_(template.deliveryLink)}" style="background:#211d19;color:white;text-decoration:none;padding:14px 22px;border-radius:10px;display:inline-block;font-weight:700">Open Your Template</a>
      </p>
      <p>Please keep this email for your records.</p>
      <p>Thank you,<br>Paanyaya Paper & Motion</p>
    </div>`;

  MailApp.sendEmail({ to: email, subject, body, htmlBody, name: 'Paanyaya Paper & Motion' });
}

function sendOwnerOrderNotice_(bookingId, clientName, email, template, receiptUrl, notes) {
  const settings = getSettings_();
  const owner = String(settings.OWNER_EMAIL || '').trim();
  if (!isEmail_(owner)) return;

  const subject = `New PPM Payment for Verification — ${bookingId}`;
  const body = [
    'New PPM template order received.',
    '',
    `Booking ID: ${bookingId}`,
    `Client: ${clientName}`,
    `Email: ${email}`,
    `Template: ${template.name}`,
    `Amount: ₱${template.price}`,
    `Receipt: ${receiptUrl}`,
    `Notes: ${notes || '-'}`,
    '',
    'Verify the payment in your receiving account, then change Payment Status to Confirmed in the Bookings sheet.'
  ].join('\n');

  MailApp.sendEmail(owner, subject, body);
}

function getTemplates_() {
  const ss = getStoreSpreadsheet_();
  const sheet = ss.getSheetByName(PPM.TEMPLATES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues().map(r => ({
    id: String(r[0] || '').trim(),
    name: String(r[1] || '').trim(),
    collection: String(r[2] || '').trim(),
    price: Number(r[3]) || PPM.PRICE,
    deliveryLink: String(r[4] || '').trim(),
    active: String(r[5] || '').trim().toUpperCase() !== 'NO',
    previewLink: String(r[6] || '').trim()
  })).filter(t => t.id);
}

/**
 * Sends the selected template's full-preview link to an email address.
 * The preview URL never needs to be exposed in getPublicConfig().
 */
function sendFullPreviewRequest(email, templateId) {
  email = clean_(email, 200).toLowerCase();
  templateId = clean_(templateId, 100);
  if (!isEmail_(email)) throw new Error('Please enter a valid email address.');

  const template = getTemplates_().find(t => t.id === templateId && t.active);
  if (!template) throw new Error('Please select an available template.');
  if (!template.previewLink) throw new Error('The full preview for this template has not been added yet.');

  const ss = getStoreSpreadsheet_();
  setupPreviewRequestsSheet_(ss);
  const sheet = ss.getSheetByName(PPM.PREVIEW_REQUESTS_SHEET);
  const settings = getSettings_();
  const brandName = settings.BRAND_NAME || 'Paanyaya Paper & Motion';
  const subject = `Your ${template.name} Full Preview — ${brandName}`;
  const body = [
    `Here is the full preview for ${template.name}.`,
    '',
    template.previewLink,
    '',
    'If you would like this design customized for your event, return to PPM and continue to payment.',
    '',
    brandName
  ].join('\n');
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#211d19;line-height:1.6">
      <p style="font-size:12px;letter-spacing:2px;text-transform:uppercase">${escapeHtml_(brandName)}</p>
      <h2>Your full preview is ready.</h2>
      <p>You requested the full preview for <strong>${escapeHtml_(template.name)}</strong>.</p>
      <p style="margin:28px 0">
        <a href="${escapeHtml_(template.previewLink)}" style="background:#211d19;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;display:inline-block;font-weight:700">View Full Preview</a>
      </p>
      <p>If you would like this design customized for your event, return to PPM and continue to payment.</p>
      <p>Paanyaya Paper & Motion</p>
    </div>`;

  try {
    MailApp.sendEmail({ to: email, subject, body, htmlBody, name: brandName });
    sheet.appendRow([new Date(), email, template.name, 'Sent']);
    return { ok: true, templateName: template.name, message: 'Preview sent! Please check your inbox.' };
  } catch (err) {
    sheet.appendRow([new Date(), email, template.name, 'Failed']);
    console.error('Preview email failed: ' + err.message);
    throw new Error('We could not send the preview email right now. Please try again.');
  }
}

function getSettings_() {
  const ss = getStoreSpreadsheet_();
  const sheet = ss.getSheetByName(PPM.SETTINGS_SHEET);
  if (!sheet) throw new Error('Settings sheet is missing. Run setupPPMStore().');
  const rows = sheet.getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][0] || '').trim();
    if (key) settings[key] = rows[i][1];
  }
  return settings;
}

function getStoreSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('PPM_STORE_SPREADSHEET_ID');
  if (!id) throw new Error('PPM Store is not set up. Run setupPPMStore() once.');
  return SpreadsheetApp.openById(id);
}

function ensureReceiptFolder_() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('PPM_RECEIPT_FOLDER_ID');
  if (existing) {
    try {
      DriveApp.getFolderById(existing).getName();
      return existing;
    } catch (err) {
      // Re-create below if the stored folder was deleted.
    }
  }

  const root = DriveApp.createFolder('PPM Customer Receipts');
  props.setProperty('PPM_RECEIPT_FOLDER_ID', root.getId());
  return root.getId();
}

function ensureAdminEditTrigger_(ss) {
  const handlers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'handleAdminEdit');
  handlers.forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('handleAdminEdit').forSpreadsheet(ss).onEdit().create();
}

function validateReceipt_(blob) {
  if (!blob || typeof blob.getBytes !== 'function') throw new Error('Please upload your payment receipt.');
  const bytes = blob.getBytes();
  if (!bytes || bytes.length === 0) throw new Error('Please upload your payment receipt.');
  if (bytes.length > PPM.RECEIPT_MAX_BYTES) throw new Error('Receipt image must be 5 MB or smaller.');
  const type = String(blob.getContentType() || '').toLowerCase();
  if (!PPM.RECEIPT_TYPES.includes(type)) throw new Error('Receipt must be JPG, PNG, or WEBP.');
}

function driveImageDataUrl_(urlOrId) {
  const id = extractDriveFileId_(urlOrId);
  if (!id) throw new Error('QR Drive URL is invalid.');
  const blob = DriveApp.getFileById(id).getBlob();
  const type = blob.getContentType() || 'image/png';
  if (!String(type).startsWith('image/')) throw new Error('QR file must be an image.');
  const bytes = blob.getBytes();
  if (bytes.length > 5 * 1024 * 1024) throw new Error('QR image must be 5 MB or smaller.');
  return `data:${type};base64,${Utilities.base64Encode(bytes)}`;
}

function extractDriveFileId_(value) {
  const s = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  const patterns = [
    /\/d\/([A-Za-z0-9_-]+)/,
    /[?&]id=([A-Za-z0-9_-]+)/,
    /\/file\/d\/([A-Za-z0-9_-]+)/
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return '';
}

function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => map[String(h).trim()] = i + 1);
  return map;
}

function createBookingId_() {
  const date = Utilities.formatDate(new Date(), PPM.TIMEZONE, 'yyyyMMdd');
  const suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 5).toUpperCase();
  return `PPM-${date}-${suffix}`;
}

function sanitizeFilename_(name) {
  return String(name || 'receipt.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function clean_(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength || 1000);
}

function isEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Convenience function: run this if you want the database URL in the Execution log. */
function showPPMStoreLinks() {
  const ss = getStoreSpreadsheet_();
  const folder = DriveApp.getFolderById(ensureReceiptFolder_());
  console.log('PPM STORE SHEET: ' + ss.getUrl());
  console.log('RECEIPT FOLDER: ' + folder.getUrl());
  return { spreadsheetUrl: ss.getUrl(), receiptFolderUrl: folder.getUrl() };
}
