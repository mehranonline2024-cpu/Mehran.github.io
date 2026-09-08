# Grill Time order system v2 — testplan before launch

Status: feature branch only. Do not merge to `main` until every critical test below passes.

## Activation order for the test session

1. Apply `supabase/migrations/20260908_order_operations_v2.sql`.
2. Deploy the four v2 Edge Functions without replacing the current functions:
   - `storefront-v2`
   - `create-order-v2`
   - `order-status-v2`
   - `admin-order-action-v2`
3. Run the customer page locally on `http://127.0.0.1:4173/order/`.
4. Open the admin page on the fixed restaurant device and a phone.
5. Merge only after the owner explicitly approves the complete test result.

## Critical customer tests

- Pickup: online, cash and terminal-in-store are the only three choices.
- Delivery: online and cash are the only choices; no terminal and no banknote question.
- Delivery under €15 food subtotal is blocked; delivery fee never counts toward the minimum.
- Address autocomplete returns only official `8400 Oostende` addresses.
- A route up to and including 2.50 km costs €2.99.
- A route above 2.50 km and up to and including 4.00 km costs €3.99.
- Outside Oostende or above 4.00 km shows the exact pickup message and a pickup button.
- No order amount receives free delivery.
- Product/option availability is checked again by the server at checkout.
- Pickup requires only first name, mobile, time and payment method.
- Delivery requires first name, mobile, selected address, delivery window, payment method and legal consent.
- Marketing consent starts unchecked.
- No account is requested.

## Hours and preorder tests

- Between 12:00 and 23:00, “as soon as possible” is available.
- At 23:00 an immediate order can still be placed; after 23:00 only a later slot is possible.
- Outside opening hours the site remains usable and offers future slots.
- Slots run in 15-minute steps from 12:00 through 23:00.
- The 12:00 slot is available at 11:30 and unavailable after 11:30.
- Delivery uses a 15-minute window; pickup uses a selected time.
- Pausing delivery blocks only immediate new delivery; pickup and later preorder slots remain.
- Temporarily closing the store blocks immediate ordering but keeps future preorder slots.

## Order-status and admin tests

- New customer message: “Bestelling ontvangen! Wacht even op de bevestiging van Grill Time.”
- Alarm repeats until accept or reject; it does not stop after one sound.
- Browser notification appears on the backup phone when permission is granted and the admin app is open/backgrounded.
- Accept creates exactly one unique printer job and opens one 80 mm print.
- Accept message: “Bestelling bevestigd. Geschatte bezorgtijd: 25–45 minuten.”
- “Bestelling onderweg” updates the customer to “Je bestelling is onderweg. Smakelijk!”
- Complete stops status polling.
- Rejecting a paid online order creates one idempotent Stripe refund.
- A first cash order above €50 cannot be accepted until telephone confirmation is acknowledged.
- The admin can pause/resume delivery, close/open the store and check the route service.
- Products, options and ingredients have Available / Sold out today / Hidden states.
- Disabling chicken, kebab, scampi, a sauce or a drink blocks every linked choice.
- “Sold out today” is visible but grey and cannot be added; it resets next opening day.

## Printer and device checks

- Confirm the 80 mm printer is reachable at its current LAN address from the existing kitchen device.
- Confirm the kitchen app consumes `printer_jobs` and marks jobs `printed` only after the printer acknowledges the job.
- Use kiosk printing on the fixed laptop/tablet if browser printing is the selected fallback.
- Test one receipt with long options, sauces, item note, order note, delivery address and phone.
- Test at 360 px phone width, tablet portrait/landscape and desktop.

## Launch gate

Do not merge or replace the current v1 Edge Functions until:

- cash pickup, cash delivery and Stripe test payments pass;
- one paid rejection/refund passes in Stripe test mode;
- one real 80 mm receipt prints automatically;
- the phone backup notification is accepted by the owner;
- the owner explicitly says to launch.
