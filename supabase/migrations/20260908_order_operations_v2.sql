-- Grill Time order operations v2
-- Additive/backwards-compatible schema for the test branch. Existing live pages
-- keep working until the feature branch is merged.

alter table public.products
  add column if not exists availability_status text not null default 'available',
  add column if not exists sold_out_on date;

alter table public.option_values
  add column if not exists availability_status text not null default 'available',
  add column if not exists sold_out_on date;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_availability_status_check'
  ) then
    alter table public.products add constraint products_availability_status_check
      check (availability_status in ('available','sold_out_today','hidden'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_values'::regclass
      and conname = 'option_values_availability_status_check'
  ) then
    alter table public.option_values add constraint option_values_availability_status_check
      check (availability_status in ('available','sold_out_today','hidden'));
  end if;
end $$;

alter table public.orders
  add column if not exists address_extra text,
  add column if not exists postal_code text,
  add column if not exists requested_at timestamptz,
  add column if not exists requested_window_end timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists tracking_token uuid not null default gen_random_uuid(),
  add column if not exists accepted_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists on_way_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists accepted_by uuid references auth.users(id) on delete set null,
  add column if not exists rejection_reason text,
  add column if not exists first_cash_phone_warning boolean not null default false,
  add column if not exists stripe_refund_id text;

create unique index if not exists orders_tracking_token_key
  on public.orders (tracking_token);
create index if not exists orders_status_created_at_idx
  on public.orders (status, created_at desc);
create index if not exists orders_requested_at_idx
  on public.orders (requested_at) where requested_at is not null;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (
  status in (
    'pending_payment','new','accepted','preparing','ready','on_way',
    'completed','rejected','cancelled'
  )
);

create table if not exists public.store_settings (
  id text primary key default 'main' check (id = 'main'),
  timezone text not null default 'Europe/Brussels',
  opens_at time not null default '12:00',
  closes_at time not null default '23:00',
  preorder_days integer not null default 7 check (preorder_days between 1 and 30),
  preparation_lead_minutes integer not null default 30 check (preparation_lead_minutes between 0 and 180),
  delivery_estimate_min integer not null default 25 check (delivery_estimate_min > 0),
  delivery_estimate_max integer not null default 45 check (delivery_estimate_max >= delivery_estimate_min),
  delivery_min_cents integer not null default 1500 check (delivery_min_cents >= 0),
  inner_distance_km numeric(4,2) not null default 2.5 check (inner_distance_km > 0),
  max_distance_km numeric(4,2) not null default 4 check (max_distance_km >= inner_distance_km),
  inner_fee_cents integer not null default 299 check (inner_fee_cents >= 0),
  outer_fee_cents integer not null default 399 check (outer_fee_cents >= 0),
  delivery_paused boolean not null default false,
  store_temporarily_closed boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.store_settings (id) values ('main')
on conflict (id) do nothing;

create table if not exists public.ingredients (
  code text primary key,
  label text not null,
  availability_status text not null default 'available'
    check (availability_status in ('available','sold_out_today','hidden')),
  sold_out_on date,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.ingredients (code,label,sort_order) values
  ('chicken','Kip',10),('kebab','Kebab / doner',20),('scampi','Scampi',30),
  ('sauce_andalouse','Andalouse',100),('sauce_samurai','Samurai',110),
  ('sauce_cocktail','Cocktail',120),('sauce_garlic','Look',130),
  ('sauce_curry_ketchup','Curry Ketchup',140),('sauce_mayonnaise','Mayonaise',150),
  ('sauce_ketchup','Ketchup',160),('drink_coca_cola','Coca-Cola',200),
  ('drink_coca_cola_zero','Coca-Cola Zero',210),('drink_fanta','Fanta',220),
  ('drink_sprite','Sprite',230)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

create table if not exists public.product_ingredient_dependencies (
  product_id text not null references public.products(id) on delete cascade,
  ingredient_code text not null references public.ingredients(code) on delete cascade,
  primary key (product_id, ingredient_code)
);

create table if not exists public.option_value_ingredient_dependencies (
  option_value_id bigint not null references public.option_values(id) on delete cascade,
  ingredient_code text not null references public.ingredients(code) on delete cascade,
  primary key (option_value_id, ingredient_code)
);

insert into public.product_ingredient_dependencies (product_id,ingredient_code)
select id, 'chicken' from public.products
where id in ('pollo','nuggets','wings','family-deal','golden-chicken-box','chicken-doner-plate')
on conflict do nothing;
insert into public.product_ingredient_dependencies (product_id,ingredient_code)
select id, 'kebab' from public.products
where id in ('loaded-doner-pizza')
on conflict do nothing;
insert into public.product_ingredient_dependencies (product_id,ingredient_code)
select id, 'scampi' from public.products
where id in ('scampi-pizza','scampi-plate')
on conflict do nothing;

insert into public.option_value_ingredient_dependencies (option_value_id,ingredient_code)
select id, 'chicken' from public.option_values
where value_code in ('kip','pita-chicken','pollo','extra_chicken')
on conflict do nothing;
insert into public.option_value_ingredient_dependencies (option_value_id,ingredient_code)
select id, 'kebab' from public.option_values
where value_code in ('kebab','pita-kebab','loaded-doner','extra_doner')
on conflict do nothing;
insert into public.option_value_ingredient_dependencies (option_value_id,ingredient_code)
select id, x.code from public.option_values ov
join (values
  ('andalouse','sauce_andalouse'),('samurai','sauce_samurai'),
  ('cocktail','sauce_cocktail'),('look','sauce_garlic'),
  ('curry-ketchup','sauce_curry_ketchup'),('mayonaise','sauce_mayonnaise'),
  ('ketchup','sauce_ketchup'),('coca-cola','drink_coca_cola'),
  ('coca-cola-zero','drink_coca_cola_zero'),('fanta','drink_fanta'),
  ('sprite','drink_sprite'),('scampi','scampi')
) as x(value_code,code) on x.value_code = ov.value_code
on conflict do nothing;

-- A mix requires both meats, so it disappears if either meat is unavailable.
insert into public.option_value_ingredient_dependencies (option_value_id,ingredient_code)
select id, x.code from public.option_values ov
cross join (values ('chicken'),('kebab')) as x(code)
where ov.value_code = 'mix'
on conflict do nothing;

create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null,
  created_at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null,
  note text
);
create index if not exists order_events_order_created_idx
  on public.order_events (order_id, created_at desc);

create table if not exists public.printer_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','printing','printed','failed')),
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  printed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists printer_jobs_status_created_idx
  on public.printer_jobs (status, created_at);

create or replace function public.log_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.order_events(order_id,status,actor_id)
    values (new.id,new.status,new.accepted_by);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_log_status_change on public.orders;
create trigger orders_log_status_change
after insert or update of status on public.orders
for each row execute function public.log_order_status_change();

create or replace function public.queue_kitchen_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'quantity',i.quantity,
      'name',i.product_name,
      'details',i.details,
      'item_note',i.item_note,
      'line_total_cents',i.line_total_cents
    ) order by i.created_at),'[]'::jsonb)
    into v_items
    from public.order_items i where i.order_id = new.id;

    insert into public.printer_jobs(order_id,payload)
    values (new.id,jsonb_build_object(
      'order_number',new.order_number,
      'order_type',new.order_type,
      'requested_time',new.requested_time,
      'requested_at',new.requested_at,
      'requested_window_end',new.requested_window_end,
      'items',v_items,
      'notes',new.notes,
      'address',case when new.order_type='delivery' then concat_ws(', ',new.address_line,new.address_extra,new.postal_code,new.city) else null end,
      'phone',new.customer_phone,
      'payment',case when new.payment_method='online' then 'Online betaald' when new.payment_method='terminal' then 'Terminal in de zaak' else 'Cash' end,
      'total_cents',new.total_cents
    )) on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_queue_kitchen_receipt on public.orders;
create trigger orders_queue_kitchen_receipt
after update of status on public.orders
for each row execute function public.queue_kitchen_receipt();

create or replace function public.touch_store_settings_updated_at()
returns trigger language plpgsql set search_path = pg_catalog,public as $$
begin new.updated_at=now(); new.updated_by=coalesce(auth.uid(),new.updated_by); return new; end $$;
drop trigger if exists store_settings_touch_updated_at on public.store_settings;
create trigger store_settings_touch_updated_at before update on public.store_settings
for each row execute function public.touch_store_settings_updated_at();

create or replace function public.touch_availability_updated_at()
returns trigger language plpgsql set search_path = pg_catalog,public as $$
begin new.updated_at=now(); return new; end $$;
drop trigger if exists ingredients_touch_updated_at on public.ingredients;
create trigger ingredients_touch_updated_at before update on public.ingredients
for each row execute function public.touch_availability_updated_at();
drop trigger if exists printer_jobs_touch_updated_at on public.printer_jobs;
create trigger printer_jobs_touch_updated_at before update on public.printer_jobs
for each row execute function public.touch_availability_updated_at();

create or replace function public.service_mark_cash_paid(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_total integer;
begin
  update public.orders
     set payment_status='paid', paid_at=coalesce(paid_at,now()),
         cash_received_at=coalesce(cash_received_at,now()), updated_at=now()
   where id=p_order_id and payment_method='cash' and payment_status='unpaid'
   returning customer_id,total_cents into v_customer_id,v_total;
  if v_customer_id is not null then
    update public.customers set order_count=order_count+1,
      total_spent_cents=total_spent_cents+v_total,last_order_at=now(),updated_at=now()
    where id=v_customer_id;
  end if;
  return p_order_id;
end;
$$;
revoke all on function public.service_mark_cash_paid(uuid) from public,anon,authenticated;
grant execute on function public.service_mark_cash_paid(uuid) to service_role;

alter table public.store_settings enable row level security;
alter table public.ingredients enable row level security;
alter table public.product_ingredient_dependencies enable row level security;
alter table public.option_value_ingredient_dependencies enable row level security;
alter table public.order_events enable row level security;
alter table public.printer_jobs enable row level security;

drop policy if exists "public read store settings" on public.store_settings;
create policy "public read store settings" on public.store_settings
for select to anon,authenticated using (true);
drop policy if exists "public read ingredients" on public.ingredients;
create policy "public read ingredients" on public.ingredients
for select to anon,authenticated using (availability_status <> 'hidden');
drop policy if exists "public read product ingredient dependencies" on public.product_ingredient_dependencies;
create policy "public read product ingredient dependencies" on public.product_ingredient_dependencies
for select to anon,authenticated using (true);
drop policy if exists "public read option ingredient dependencies" on public.option_value_ingredient_dependencies;
create policy "public read option ingredient dependencies" on public.option_value_ingredient_dependencies
for select to anon,authenticated using (true);

drop policy if exists "restaurant admins manage store settings" on public.store_settings;
create policy "restaurant admins manage store settings" on public.store_settings
for update to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins manage products" on public.products;
create policy "restaurant admins manage products" on public.products
for update to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins read all products" on public.products;
create policy "restaurant admins read all products" on public.products
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins manage option values" on public.option_values;
create policy "restaurant admins manage option values" on public.option_values
for update to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins read all option values" on public.option_values;
create policy "restaurant admins read all option values" on public.option_values
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins manage ingredients" on public.ingredients;
create policy "restaurant admins manage ingredients" on public.ingredients
for all to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins read order events" on public.order_events;
create policy "restaurant admins read order events" on public.order_events
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));
drop policy if exists "restaurant admins manage printer jobs" on public.printer_jobs;
create policy "restaurant admins manage printer jobs" on public.printer_jobs
for all to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=auth.uid()));

-- Keep hidden items out of the public catalogue while retaining sold-out items.
drop policy if exists "public read active products" on public.products;
create policy "public read active products" on public.products
for select to anon,authenticated using (active = true and availability_status <> 'hidden');
drop policy if exists "public read active option values" on public.option_values;
create policy "public read active option values" on public.option_values
for select to anon,authenticated using (active = true and availability_status <> 'hidden');

do $$ begin
  alter publication supabase_realtime add table public.store_settings;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ingredients;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.printer_jobs;
exception when duplicate_object then null; end $$;

comment on table public.store_settings is 'Single-row operational settings for opening hours, delivery pause and delivery pricing.';
comment on column public.orders.tracking_token is 'Opaque token used by the public order-status page; never expose order UUIDs.';
comment on table public.printer_jobs is 'One idempotent 80 mm kitchen receipt job created when an order is accepted.';
