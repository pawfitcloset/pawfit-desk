# 🐾 Google Sheets Integration — Setup Guide

## How it works

Every time you **pin a comment** as a winner, the order is automatically saved to a Google Sheet.  
You can also click **"Sync to Sheet"** at any time to update all rows with the latest DP/payment data.

---

## Step 1 — Create Google Cloud OAuth2 Credentials

> You only need to do this once.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for **"Google Sheets API"** and click **Enable**
5. Go to **APIs & Services → OAuth consent screen**
   - Choose **External**
   - Fill in app name (e.g. `Pawfit Desk`)
   - Add your Google email as a **Test user** (under "Test users" section)
   - Save & Continue through the steps
6. Go to **APIs & Services → Credentials → Create Credentials → OAuth Client ID**
   - Application type: **Web application**
   - Name: `Pawfit Desk`
   - Under **Authorized redirect URIs**, add both your local and deployed URLs:
     - Local: `http://localhost:3001/oauth2callback`
     - Deployed (Render / production): `https://<your-render-app-name>.onrender.com/oauth2callback`
   - Click **Create** (or **Save** if editing an existing Client ID)
7. Click **Download JSON** on the created credential
8. Rename the downloaded file to **`google-credentials.json`**
9. Place it in your project root: `c:\Users\Admin\tiktok-dashboard\google-credentials.json`
   > **Note for Render Deployment**: If deploying to Render, set these Environment Variables in your Render Dashboard:
   > - `GOOGLE_CLIENT_ID` (from your Google Cloud credential)
   > - `GOOGLE_CLIENT_SECRET` (from your Google Cloud credential)
   > - `GOOGLE_REDIRECT_URI`: `https://<your-render-app-name>.onrender.com/oauth2callback`

---

## Step 2 — Connect in the App

1. Start the server: `node server.js`
2. Open the dashboard in your browser
3. Click **"Connect Sheets"** in the top-right header
4. A Google login popup opens — sign in with your account
5. After login, the popup closes and the header shows **Sheets ✓** in green

---

## Step 3 — Using Google Sheets

| Action | What happens |
|--------|-------------|
| Pin a comment | Order is **auto-appended** to the sheet |
| Enter DP amount | Updated locally; click **Sync to Sheet** to push |
| Click **Sync to Sheet** | All rows + DP/balance/status updated; Summary tab refreshed |
| Click 🔗 External Link icon | Opens the Google Sheet in a new tab |
| Click logout icon | Disconnects from Google Sheets |

---

## Sheet Structure

**Orders tab:**

| Buyer Name | Username | Item Code | Price (₱) | DP Paid (₱) | Balance (₱) | Status | Time | Session Date |
|---|---|---|---|---|---|---|---|---|

**Summary tab:** Total orders, unique buyers, total sales, DP collected, outstanding balance.

---

## Notes

- The spreadsheet is **auto-created** on first use (named `Pawfit Desk Orders – <date>`)
- You can also paste your own Spreadsheet ID by hitting `POST /sheets/set-id`
- The OAuth token is saved to `google-token.json` — you won't need to log in again unless it expires
- The last spreadsheet ID is saved to `active-spreadsheet-id.txt`

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No Google credentials configured" | Make sure `google-credentials.json` is in the project root |
| Popup doesn't close after login | Token was saved. Refresh the dashboard — it will show as connected |
| 403 Forbidden error | Make sure your Google account is added as a Test User in the OAuth consent screen |
| Token expired | Click Disconnect, then Connect Sheets again to re-auth |
