-- Grill Time: harden direct database access and optimize admin RLS checks.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_restaurant_admin_aal2()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
    and exists (
      select 1
      from public.restaurant_admins as admin_row
      where admin_row.user_id = (select auth.uid())
    );
$$;

revoke all on function private.is_restaurant_admin_aal2() from public;
grant execute on function private.is_restaurant_admin_aal2() to authenticated;

drop policy if exists "admin can see own admin row" on public.restaurant_admins;
create policy "admin can see own admin row"
on public.restaurant_admins
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "restaurant admins read customers" on public.customers;
create policy "restaurant admins read customers"
on public.customers
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins read order items" on public.order_items;
create policy "restaurant admins read order items"
on public.order_items
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins read orders" on public.orders;
create policy "restaurant admins read orders"
on public.orders
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins update orders" on public.orders;
create policy "restaurant admins update orders"
on public.orders
for update
to authenticated
using ((select private.is_restaurant_admin_aal2()))
with check ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins manage store settings" on public.store_settings;
create policy "restaurant admins manage store settings"
on public.store_settings
for update
to authenticated
using ((select private.is_restaurant_admin_aal2()))
with check ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins read store settings" on public.store_settings;
create policy "restaurant admins read store settings"
on public.store_settings
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins manage products" on public.products;
create policy "restaurant admins manage products"
on public.products
for update
to authenticated
using ((select private.is_restaurant_admin_aal2()))
with check ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins read all products" on public.products;
create policy "restaurant admins read all products"
on public.products
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins manage option values" on public.option_values;
create policy "restaurant admins manage option values"
on public.option_values
for update
to authenticated
using ((select private.is_restaurant_admin_aal2()))
with check ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins read all option values" on public.option_values;
create policy "restaurant admins read all option values"
on public.option_values
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins manage ingredients" on public.ingredients;
create policy "restaurant admins manage ingredients"
on public.ingredients
for all
to authenticated
using ((select private.is_restaurant_admin_aal2()))
with check ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins read order events" on public.order_events;
create policy "restaurant admins read order events"
on public.order_events
for select
to authenticated
using ((select private.is_restaurant_admin_aal2()));

drop policy if exists "restaurant admins manage printer jobs" on public.printer_jobs;
create policy "restaurant admins manage printer jobs"
on public.printer_jobs
for all
to authenticated
using ((select private.is_restaurant_admin_aal2()))
with check ((select private.is_restaurant_admin_aal2()));

-- Public storefront reads as anon; authenticated admins use the full-read policy.
drop policy if exists "public read active products" on public.products;
create policy "public read active products"
on public.products
for select
to anon
using (active = true and availability_status <> 'hidden');

drop policy if exists "public read active option values" on public.option_values;
create policy "public read active option values"
on public.option_values
for select
to anon
using (active = true and availability_status <> 'hidden');

-- These mapping tables are server-only. Keep the denial explicit as defense in depth.
revoke all on table public.option_value_ingredient_dependencies from anon, authenticated;
revoke all on table public.product_ingredient_dependencies from anon, authenticated;

drop policy if exists "server only dependency mapping" on public.option_value_ingredient_dependencies;
create policy "server only dependency mapping"
on public.option_value_ingredient_dependencies
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "server only dependency mapping" on public.product_ingredient_dependencies;
create policy "server only dependency mapping"
on public.product_ingredient_dependencies
for all
to anon, authenticated
using (false)
with check (false);

create index if not exists option_value_dependencies_ingredient_code_idx
  on public.option_value_ingredient_dependencies (ingredient_code);
create index if not exists product_dependencies_ingredient_code_idx
  on public.product_ingredient_dependencies (ingredient_code);
create index if not exists order_events_actor_id_idx
  on public.order_events (actor_id);
create index if not exists orders_accepted_by_idx
  on public.orders (accepted_by);
create index if not exists store_settings_updated_by_idx
  on public.store_settings (updated_by);
