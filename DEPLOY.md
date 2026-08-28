# JIA Parking - Deployment Guide

## Step 1: Google Sheet Setup

1. Go to https://sheets.google.com
2. Create a new sheet named `JIA Parking Data`
3. Rename Sheet1 to `Members` and add these headers in row 1:
   - A1: QR_ID
   - B1: Plate_Number
   - C1: Owner_Name
   - D1: Active
   - E1: Date_Created
4. Add a second tab named `ParkingLog` with headers:
   - A1: Ticket_No
   - B1: QR_ID
   - C1: Plate
   - D1: Time_In
   - E1: Time_Out
   - F1: Duration_Hrs
   - G1: Charge_PHP
   - H1: Status
5. Copy the Sheet ID from the URL (between /d/ and /edit)

## Step 2: Google Service Account

1. Go to https://console.cloud.google.com
2. Create a new project (or use existing) - e.g. "JIA Parking"
3. Enable "Google Sheets API" (APIs & Services > Library)
4. Go to APIs & Services > Credentials > Create Credentials > Service Account
5. Name it "jia-parking-bot" > Create
6. Click on the service account > Keys tab > Add Key > Create new key > JSON
7. Download the JSON file
8. From the JSON, copy `client_email` and `private_key`
9. **Share your Google Sheet with the client_email** (as Editor)

## Step 3: Push to GitHub

1. Create a new GitHub repo (private): `JIA_Parking`
2. Upload all files in the JIA_Parking folder via github.com web UI
   (drag and drop the files - use "Upload files" button)
3. Commit

## Step 4: Deploy on Vercel

1. Go to https://vercel.com > Sign in with GitHub
2. Click "Add New Project" > Import your JIA_Parking repo
3. Framework Preset: **Other**
4. Build Command: (leave empty)
5. Output Directory: (leave empty)
6. Add Environment Variables:
   - `GOOGLE_SHEET_ID` = your sheet ID from Step 1
   - `GOOGLE_CLIENT_EMAIL` = client_email from Step 2 JSON
   - `GOOGLE_PRIVATE_KEY` = private_key from Step 2 JSON (paste the whole thing including BEGIN/END lines, keep the \n as \n)
7. Click Deploy

## Step 5: Test

1. Open your Vercel URL: https://jia-parking.vercel.app
2. Go to /admin - Register your first member (test plate)
3. Download the QR
4. Open /cashier on your phone
5. Scan the QR - should say ENTRY - Ticket Issued
6. Wait a moment, scan again - should say EXIT - PHP 20

## Charge Rules
- First 3 hours: PHP 20 (flat)
- Every succeeding hour: +PHP 10 (partial hour = 1 hour)

Example:
- 2 hrs = P20
- 3 hrs = P20
- 3.5 hrs = P30
- 5 hrs = P40
- 8 hrs = P70

## URLs
- Admin: `/admin` - Register members, generate QR
- Cashier: `/cashier` - Scan QRs at parking entry/exit
- Reports: `/reports` - View history and totals
