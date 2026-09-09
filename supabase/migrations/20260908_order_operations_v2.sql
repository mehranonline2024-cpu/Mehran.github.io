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
  add column if not exists stripe_refund_id text,
  add column if not exists client_request_id uuid,
  add column if not exists request_fingerprint text;

create unique index if not exists orders_tracking_token_key
  on public.orders (tracking_token);
create unique index if not exists orders_client_request_id_key
  on public.orders (client_request_id) where client_request_id is not null;
create index if not exists orders_status_created_at_idx
  on public.orders (status, created_at desc);
create index if not exists orders_requested_at_idx
  on public.orders (requested_at) where requested_at is not null;
create index if not exists orders_customer_id_idx
  on public.orders (customer_id);
create index if not exists order_items_order_id_idx
  on public.order_items (order_id);
create index if not exists order_items_product_id_idx
  on public.order_items (product_id);
create index if not exists product_option_groups_group_id_idx
  on public.product_option_groups (group_id);

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
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.order_events(order_id,status,actor_id)
    values (new.id,new.status,new.accepted_by);
  end if;
  return new;
end;
$$;
revoke execute on function public.log_order_status_change() from public,anon,authenticated;

drop trigger if exists orders_log_status_change on public.orders;
create trigger orders_log_status_change
after insert or update of status on public.orders
for each row execute function public.log_order_status_change();

create or replace function public.queue_kitchen_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
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
revoke execute on function public.queue_kitchen_receipt() from public,anon,authenticated;

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
set search_path = ''
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

-- Creates the customer, order and order lines in one database transaction.
-- The Edge Function validates catalogue data first; this RPC provides atomicity
-- and guarantees that retrying one client request never creates a second order.
create or replace function public.service_create_order_v2(
  p_request_id uuid,
  p_request_fingerprint text,
  p_customer jsonb,
  p_order jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.orders%rowtype;
  v_customer_id uuid;
  v_order public.orders%rowtype;
  v_phone_normalized text := nullif(trim(p_customer->>'phone_normalized'), '');
  v_phone text := nullif(trim(p_customer->>'phone'), '');
  v_name text := nullif(trim(p_customer->>'name'), '');
  v_email text := nullif(trim(p_customer->>'email'), '');
  v_order_type text := p_order->>'order_type';
  v_payment_method text := p_order->>'payment_method';
  v_subtotal_cents integer := (p_order->>'subtotal_cents')::integer;
  v_delivery_fee_cents integer := coalesce((p_order->>'delivery_fee_cents')::integer, 0);
  v_discount_cents integer;
  v_total_cents integer;
  v_prior_order_count integer;
  v_prior_cash_count integer;
  v_first_cash_warning boolean := false;
  v_item jsonb;
begin
  if p_request_id is null then raise exception 'request_id is required'; end if;
  if p_request_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'invalid request fingerprint'; end if;
  if v_phone_normalized is null or v_phone is null or v_name is null then raise exception 'invalid customer'; end if;
  if v_order_type not in ('pickup','delivery') then raise exception 'invalid order type'; end if;
  if v_payment_method not in ('online','cash','terminal') then raise exception 'invalid payment method'; end if;
  if v_order_type = 'delivery' and v_payment_method = 'terminal' then raise exception 'terminal is not available for delivery'; end if;
  if v_subtotal_cents < 50 or v_delivery_fee_cents < 0 then raise exception 'invalid totals'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items are required'; end if;

  -- Serialize retries for this request before checking whether it already exists.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  select * into v_existing from public.orders where client_request_id = p_request_id;
  if found then
    if v_existing.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'request_id was already used with different order data';
    end if;
    return jsonb_build_object(
      'orderId',v_existing.id,'orderNumber',v_existing.order_number,
      'trackingToken',v_existing.tracking_token,'customerId',v_existing.customer_id,
      'subtotalCents',v_existing.subtotal_cents,'discountCents',v_existing.discount_cents,
      'discountCode',v_existing.discount_code,'deliveryFeeCents',v_existing.delivery_fee_cents,
      'deliveryDistanceKm',v_existing.delivery_distance_km,'totalCents',v_existing.total_cents,
      'firstCashPhoneWarning',v_existing.first_cash_phone_warning,
      'paymentMethod',v_existing.payment_method,'paymentStatus',v_existing.payment_status,
      'status',v_existing.status,'stripeCheckoutSessionId',v_existing.stripe_checkout_session_id,
      'replayed',true
    );
  end if;

  -- Serialize first-order discount and first-cash-warning decisions per phone.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_phone_normalized, 1));
  select id into v_customer_id
    from public.customers
   where phone_normalized = v_phone_normalized or phone = v_phone
   order by case when phone_normalized = v_phone_normalized then 0 else 1 end, created_at
   limit 1 for update;

  if v_customer_id is null then
    begin
      insert into public.customers(name,phone,email,phone_normalized)
      values (v_name,v_phone,v_email,v_phone_normalized)
      returning id into v_customer_id;
    exception when unique_violation then
      select id into v_customer_id from public.customers
       where phone_normalized = v_phone_normalized or phone = v_phone
       order by created_at limit 1 for update;
      if v_customer_id is null then raise; end if;
    end;
  else
    update public.customers
       set name=v_name, phone=v_phone, email=coalesce(v_email,email),
           phone_normalized=v_phone_normalized, updated_at=now()
     where id=v_customer_id;
  end if;

  select count(*)::integer into v_prior_order_count
    from public.orders
   where customer_id=v_customer_id and status not in ('cancelled','rejected');
  v_discount_cents := case when v_prior_order_count=0 then round(v_subtotal_cents * 0.10)::integer else 0 end;
  v_total_cents := v_subtotal_cents - v_discount_cents + v_delivery_fee_cents;

  if v_payment_method='cash' and v_total_cents>5000 then
    select count(*)::integer into v_prior_cash_count
      from public.orders
     where customer_id=v_customer_id and payment_method='cash'
       and status not in ('cancelled','rejected');
    v_first_cash_warning := v_prior_cash_count=0;
  end if;

  insert into public.orders(
    customer_id,customer_name,customer_phone,customer_email,order_type,
    requested_time,requested_at,requested_window_end,address_line,address_extra,
    postal_code,city,notes,status,payment_status,payment_method,subtotal_cents,
    discount_cents,discount_code,delivery_fee_cents,delivery_distance_km,
    delivery_distance_method,total_cents,currency,terms_accepted_at,
    marketing_consent,first_cash_phone_warning,client_request_id,request_fingerprint
  ) values (
    v_customer_id,v_name,v_phone,v_email,v_order_type,
    coalesce(nullif(p_order->>'requested_time',''),'Zo snel mogelijk'),
    nullif(p_order->>'requested_at','')::timestamptz,
    nullif(p_order->>'requested_window_end','')::timestamptz,
    nullif(p_order->>'address_line',''),nullif(p_order->>'address_extra',''),
    nullif(p_order->>'postal_code',''),nullif(p_order->>'city',''),nullif(p_order->>'notes',''),
    case when v_payment_method='online' then 'pending_payment' else 'new' end,
    'unpaid',v_payment_method,v_subtotal_cents,v_discount_cents,
    case when v_discount_cents>0 then 'WELCOME10' else null end,
    v_delivery_fee_cents,nullif(p_order->>'delivery_distance_km','')::numeric,
    nullif(p_order->>'delivery_distance_method',''),v_total_cents,'eur',
    case when coalesce((p_order->>'terms_accepted')::boolean,false) then now() else null end,
    coalesce((p_order->>'marketing_consent')::boolean,false),v_first_cash_warning,
    p_request_id,p_request_fingerprint
  ) returning * into v_order;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into public.order_items(
      order_id,product_id,product_name,quantity,unit_price_cents,line_total_cents,
      selected_options,details,item_note
    ) values (
      v_order.id,nullif(v_item->>'product_id',''),v_item->>'product_name',
      (v_item->>'quantity')::integer,(v_item->>'unit_price_cents')::integer,
      (v_item->>'line_total_cents')::integer,coalesce(v_item->'selected_options','{}'::jsonb),
      coalesce(v_item->'details','[]'::jsonb),nullif(v_item->>'item_note','')
    );
  end loop;

  return jsonb_build_object(
    'orderId',v_order.id,'orderNumber',v_order.order_number,'trackingToken',v_order.tracking_token,
    'customerId',v_customer_id,'subtotalCents',v_order.subtotal_cents,
    'discountCents',v_order.discount_cents,'discountCode',v_order.discount_code,
    'deliveryFeeCents',v_order.delivery_fee_cents,'deliveryDistanceKm',v_order.delivery_distance_km,
    'totalCents',v_order.total_cents,'firstCashPhoneWarning',v_order.first_cash_phone_warning,
    'paymentMethod',v_order.payment_method,'paymentStatus',v_order.payment_status,
    'status',v_order.status,'stripeCheckoutSessionId',v_order.stripe_checkout_session_id,
    'replayed',false
  );
end;
$$;
revoke all on function public.service_create_order_v2(uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_create_order_v2(uuid,text,jsonb,jsonb,jsonb) to service_role;

alter table public.store_settings enable row level security;
alter table public.ingredients enable row level security;
alter table public.product_ingredient_dependencies enable row level security;
alter table public.option_value_ingredient_dependencies enable row level security;
alter table public.order_events enable row level security;
alter table public.printer_jobs enable row level security;

drop policy if exists "public read store settings" on public.store_settings;
drop policy if exists "public read ingredients" on public.ingredients;
drop policy if exists "public read product ingredient dependencies" on public.product_ingredient_dependencies;
drop policy if exists "public read option ingredient dependencies" on public.option_value_ingredient_dependencies;

drop policy if exists "restaurant admins manage store settings" on public.store_settings;
create policy "restaurant admins manage store settings" on public.store_settings
for update to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins read store settings" on public.store_settings;
create policy "restaurant admins read store settings" on public.store_settings
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins manage products" on public.products;
create policy "restaurant admins manage products" on public.products
for update to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins read all products" on public.products;
create policy "restaurant admins read all products" on public.products
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins manage option values" on public.option_values;
create policy "restaurant admins manage option values" on public.option_values
for update to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins read all option values" on public.option_values;
create policy "restaurant admins read all option values" on public.option_values
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins manage ingredients" on public.ingredients;
create policy "restaurant admins manage ingredients" on public.ingredients
for all to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins read order events" on public.order_events;
create policy "restaurant admins read order events" on public.order_events
for select to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));
drop policy if exists "restaurant admins manage printer jobs" on public.printer_jobs;
create policy "restaurant admins manage printer jobs" on public.printer_jobs
for all to authenticated
using ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())))
with check ((select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.restaurant_admins a where a.user_id=(select auth.uid())));

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
