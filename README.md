# Pre-Approval Dashboard

This folder contains a lightweight local dashboard for live HubSpot data focused on:

- Finance First contact-level pre-approval version: `Quick` vs `Normal`
- Associated deals and pre-approval type
- Booking confirmed date coverage
- Payment mode split
- Car First deal-level version analysis
- Unique-customer first-touch logic across Finance First and Car First without double counting

## Files

- `index.html`: dashboard shell
- `styles.css`: UI styling
- `script.js`: browser-side rendering
- `server.mjs`: local server and private HubSpot fetch layer

## How to use

1. Run `node server.mjs` from [pre-approval-dashboard](/Users/a38651/Documents/Codex/2026-05-28/need-to-build-a-dashboard-for/pre-approval-dashboard).
2. Open [http://localhost:4173](http://localhost:4173).
3. Click `Refresh Dashboard`.

The server uses `HUBSPOT_TOKEN` from your environment if present. If not, it falls back to the existing local `.env` found in your older HubSpot project.
The dashboard start date is fixed at `2026-05-18`.

## HubSpot fields used

### Contacts

- `email`
- `phone`
- `pre_approval_type`
- `pre_approval_version`
- `payment_mode`
- `pre_approval_start_date`
- `createdate`

### Deals

- `dealname`
- `pre_approval_version`
- `payment_mode`
- `booking_confirm_date`
- `createdate`

## Business logic implemented

### Finance First

- Uses `pre_approval_type = FINANCE_FIRST`
- Uses contact-level `pre_approval_version`
- Links associated Finance First deals to the same customer
- Counts booking confirmed rows where `Booking Confirmed Date` is populated
- Builds payment mode split from booking-confirmed Finance First deals

### Car First

- Uses `pre_approval_type = CAR_FIRST`
- Uses the earliest associated deal-level `pre_approval_version`
- Aggregates at unique customer level to avoid double counting
- Builds the same booking confirmed and payment mode view

### No double counting

- Customer identity is resolved using `email`, then `phone`, then `contactId`
- Each customer gets one first-touch source using the earliest available touch date across:
  - Finance First contact `pre_approval_start_date` or `createdate`
  - Car First contact `pre_approval_start_date` or `createdate`
  - Car First deal creation

## Next useful step

If you want, I can extend this into either:

1. A richer dashboard with charts and filters
2. A CSV export for the deduplicated customer-level base table
3. A React or Vite version if you want to deploy it cleanly
