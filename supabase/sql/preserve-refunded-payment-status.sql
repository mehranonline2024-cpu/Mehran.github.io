CREATE OR REPLACE FUNCTION public.mark_order_paid(p_session_id text, p_payment_intent_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_total integer;
begin
  update public.orders
     set payment_status = 'paid',
         status = case when status = 'pending_payment' then 'new' else status end,
         paid_at = coalesce(paid_at, now()),
         stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
         updated_at = now()
   where stripe_checkout_session_id = p_session_id
     and payment_status not in ('paid', 'refunded')
  returning id, customer_id, total_cents into v_order_id, v_customer_id, v_total;

  if v_order_id is not null and v_customer_id is not null then
    update public.customers
       set order_count = order_count + 1,
           total_spent_cents = total_spent_cents + v_total,
           last_order_at = now(),
           updated_at = now()
     where id = v_customer_id;
  end if;

  if v_order_id is null then
    select id into v_order_id from public.orders where stripe_checkout_session_id = p_session_id;
  end if;

  return v_order_id;
end;
$function$;
