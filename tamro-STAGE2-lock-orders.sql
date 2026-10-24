-- ═══════════════════════════════════════════════════════════════════════════
-- TAMRO — STAGE 2: close public access to the orders table.
-- DO NOT RUN until ALL of this is true:
--   1. The new index.html (with the staff gateway) is live for admin, rider, manager AND customer.
--   2. You set the admin password secrets (STAFF_ADMIN_USER / STAFF_ADMIN_PASS) and admin login works.
--   3. Every rider and manager opened their app once and signed in again.
--   4. You placed a test order from the customer app and saw it in admin + rider app.
-- After this, the public key in the app can only PLACE an order (not read, change or delete any).
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists "allow all"        on public.orders;
drop policy if exists allow_all_orders   on public.orders;
drop policy if exists public_all         on public.orders;

create policy orders_customer_insert on public.orders
  for insert to anon
  with check (coalesce(status,'new') = 'new' and accepted_by is null);

revoke select, update, delete on public.orders from anon;

-- ─────────────── UNDO (if anything goes wrong, run this to reopen like before) ───────────────
-- drop policy if exists orders_customer_insert on public.orders;
-- create policy "allow all" on public.orders for all using (true) with check (true);
-- grant select, update, delete on public.orders to anon;
