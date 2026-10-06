-- Only owner-verified allergen information is displayed. Existing data stays unknown.
alter table public.products
 add column allergens_contains text[],
 add column allergens_may_contain text[],
 add column allergens_verified_at timestamptz,
 add constraint products_allergen_codes check (
   (allergens_contains is null or (allergens_contains <@ ARRAY['wheat','rye','barley','oats','spelt','khorasan','crustaceans','eggs','fish','peanuts','soy','milk','almonds','hazelnuts','walnuts','cashews','pecans','brazil_nuts','pistachios','macadamia','celery','mustard','sesame','sulphites','lupin','molluscs']::text[] and array_position(allergens_contains,null) is null))
   and (allergens_may_contain is null or (allergens_may_contain <@ ARRAY['wheat','rye','barley','oats','spelt','khorasan','crustaceans','eggs','fish','peanuts','soy','milk','almonds','hazelnuts','walnuts','cashews','pecans','brazil_nuts','pistachios','macadamia','celery','mustard','sesame','sulphites','lupin','molluscs']::text[] and array_position(allergens_may_contain,null) is null))
   and (allergens_verified_at is null or (allergens_contains is not null and allergens_may_contain is not null))
 );
comment on column public.products.allergens_verified_at is 'Owner verified current recipe and supplier labels. NULL means unknown, never allergen-free. Existing MFA admin update policy applies.';
alter table public.option_values
 add column allergens_contains text[],
 add column allergens_may_contain text[],
 add column allergens_verified_at timestamptz,
 add constraint option_values_allergen_codes check (
   (allergens_contains is null or (allergens_contains <@ ARRAY['wheat','rye','barley','oats','spelt','khorasan','crustaceans','eggs','fish','peanuts','soy','milk','almonds','hazelnuts','walnuts','cashews','pecans','brazil_nuts','pistachios','macadamia','celery','mustard','sesame','sulphites','lupin','molluscs']::text[] and array_position(allergens_contains,null) is null))
   and (allergens_may_contain is null or (allergens_may_contain <@ ARRAY['wheat','rye','barley','oats','spelt','khorasan','crustaceans','eggs','fish','peanuts','soy','milk','almonds','hazelnuts','walnuts','cashews','pecans','brazil_nuts','pistachios','macadamia','celery','mustard','sesame','sulphites','lupin','molluscs']::text[] and array_position(allergens_may_contain,null) is null))
   and (allergens_verified_at is null or (allergens_contains is not null and allergens_may_contain is not null))
 );
comment on column public.option_values.allergens_verified_at is 'Owner verified current recipe and supplier labels. NULL means unknown, never allergen-free. Existing MFA admin update policy applies.';

-- Preserve one kitchen job per accepted order; add receipt breakdown and customer name.
create or replace function public.queue_kitchen_receipt()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_items jsonb;
begin
 if new.status='accepted' and old.status is distinct from 'accepted' then
   if new.payment_method='online' and new.payment_status is distinct from 'paid' then return new; end if;
   select coalesce(jsonb_agg(jsonb_build_object(
     'quantity',i.quantity,'name',i.product_name,'details',i.details,
     'item_note',i.item_note,'line_total_cents',i.line_total_cents
   ) order by i.created_at),'[]'::jsonb)
   into v_items from public.order_items i where i.order_id=new.id;
   insert into public.printer_jobs(order_id,payload)
   values(new.id,jsonb_build_object(
     'order_number',new.order_number,'order_type',new.order_type,
     'requested_time',new.requested_time,'requested_at',new.requested_at,
     'requested_window_end',new.requested_window_end,'items',v_items,
     'customer_name',new.customer_name,'notes',new.notes,
     'address',case when new.order_type='delivery'
       then concat_ws(', ',new.address_line,new.address_extra,new.postal_code,new.city) else null end,
     'phone',new.customer_phone,
     'payment',case when new.payment_method='online' then 'Online betaald'
       when new.payment_method='terminal' then 'Terminal in de zaak' else 'Cash' end,
     'subtotal_cents',new.subtotal_cents,'discount_cents',new.discount_cents,
     'delivery_fee_cents',new.delivery_fee_cents,'total_cents',new.total_cents
   )) on conflict(order_id) do nothing;
 end if;
 return new;
end;
$function$;
