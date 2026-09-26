PPM — CLOUDFLARE PAGES VERSION 1
================================

PURPOSE
-------
This is the Cloudflare replacement for the previous Netlify deployment.
The customer-facing site stays static, while /api/ppm is handled by a
Cloudflare Pages Function that securely forwards requests to Google Apps Script.

STRUCTURE
---------
PPM_Cloudflare_V1/
  public/
    index.html
    social-preview.png
    _headers
  functions/
    api/
      ppm.js
  apps-script/
    Code.gs

IMPORTANT
---------
You do NOT need to replace Apps Script just to migrate hosting if your existing
Apps Script /exec deployment is already working. The apps-script/Code.gs file is
included only as a backup/reference copy of the backend used by the site.

CLOUDFLARE PAGES SETTINGS
-------------------------
Connect the existing private GitHub repository to Cloudflare Pages.

If you upload this WHOLE folder into the repository:
  Root directory: PPM_Cloudflare_V1
  Build command: leave blank
  Build output directory: public

If the CONTENTS of this folder are placed directly at repository root:
  Root directory: leave blank
  Build command: leave blank
  Build output directory: public

ENVIRONMENT VARIABLES / SECRETS
-------------------------------
Add these to the Cloudflare Pages project for Production:

PPM_APPS_SCRIPT_URL
  Your existing Apps Script Web App /exec URL.

PPM_PROXY_SECRET
  The same secret already stored in Apps Script Script Properties.

Never put either secret value in index.html or commit them to GitHub.

TESTS
-----
After deployment:

1. Open the main Pages URL. The PPM template website should load.

2. Open:
   https://YOUR-PROJECT.pages.dev/api/ppm

Expected result:
   {"ok":false,"error":"Method not allowed."}

That 405 response is GOOD. It proves the Pages Function exists.

3. Test Request Full Preview.
4. Test one receipt submission.
5. Confirm that the row reaches the existing Google Sheet.

WHAT CHANGED FROM NETLIFY
-------------------------
Old frontend endpoint:
  /.netlify/functions/ppm

New frontend endpoint:
  /api/ppm

Old server function:
  netlify/functions/ppm.js

New Cloudflare Pages Function:
  functions/api/ppm.js

The Google Apps Script backend, Sheets, Drive, emails, templates, and existing
proxy secret can remain the same.
