begin;

do $$
declare
  v_request_id uuid := gen_random_uuid();
  v_failed_request_id uuid := gen_random_uuid();
  v_first jsonb;
  v_second jsonb;
  v_count integer;
  v_failed boolean := false;
begin
  if has_function_privilege('anon', 'public.service_create_order_v2(uuid,text,jsonb,jsonb,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_create_order_v2(uuid,text,jsonb,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'service_create_order_v2 must not be callable by public API roles';
  end if;

  v_first := public.service_create_order_v2(
    v_request_id,
    repeat('a',64),
    jsonb_build_object('name','Idempotency Test','phone','0499999999','email',null,'phone_normalized','0499999999'),
    jsonb_build_object(
      'order_type','pickup','payment_method','cash','requested_time','Test',
      'requested_at',null,'requested_window_end',null,'subtotal_cents',1000,
      'delivery_fee_cents',0,'delivery_distance_km',null,'delivery_distance_method',null,
      'terms_accepted',false,'marketing_consent',false
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id',null,'product_name','Transaction Test','quantity',1,
      'unit_price_cents',1000,'line_total_cents',1000,
      'selected_options','{}'::jsonb,'details','[]'::jsonb,'item_note',null
    ))
  );

  v_second := public.service_create_order_v2(
    v_request_id,
    repeat('a',64),
    jsonb_build_object('name','Idempotency Test','phone','0499999999','email',null,'phone_normalized','0499999999'),
    jsonb_build_object(
      'order_type','pickup','payment_method','cash','requested_time','Test',
      'requested_at',null,'requested_window_end',null,'subtotal_cents',1000,
      'delivery_fee_cents',0,'delivery_distance_km',null,'delivery_distance_method',null,
      'terms_accepted',false,'marketing_consent',false
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id',null,'product_name','Transaction Test','quantity',1,
      'unit_price_cents',1000,'line_total_cents',1000,
      'selected_options','{}'::jsonb,'details','[]'::jsonb,'item_note',null
    ))
  );

  if v_first->>'orderId' is distinct from v_second->>'orderId' then
    raise exception 'retry created a second order';
  end if;
  if coalesce((v_second->>'replayed')::boolean,false) is not true then
    raise exception 'retry was not marked as replayed';
  end if;
  select count(*) into v_count from public.orders where client_request_id=v_request_id;
  if v_count <> 1 then raise exception 'expected one order, found %',v_count; end if;
  select count(*) into v_count from public.order_items where order_id=(v_first->>'orderId')::uuid;
  if v_count <> 1 then raise exception 'expected one order item, found %',v_count; end if;

  begin
    perform public.service_create_order_v2(
      v_failed_request_id,
      repeat('b',64),
      jsonb_build_object('name','Rollback Test','phone','0488888888','email',null,'phone_normalized','0488888888'),
      jsonb_build_object(
        'order_type','pickup','payment_method','cash','requested_time','Test',
        'requested_at',null,'requested_window_end',null,'subtotal_cents',1000,
        'delivery_fee_cents',0,'delivery_distance_km',null,'delivery_distance_method',null,
        'terms_accepted',false,'marketing_consent',false
      ),
      jsonb_build_array(jsonb_build_object(
        'product_id',null,'product_name','Rollback Test','quantity',0,
        'unit_price_cents',1000,'line_total_cents',1000,
        'selected_options','{}'::jsonb,'details','[]'::jsonb,'item_note',null
      ))
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'invalid item should have failed'; end if;
  select count(*) into v_count from public.orders where client_request_id=v_failed_request_id;
  if v_count <> 0 then raise exception 'failed transaction left an orphan order'; end if;
end;
$$;

rollback;
