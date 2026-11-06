-- Run after kustivo3-second-order.sql. Everything is rolled back, including events.
BEGIN;
DO $$
DECLARE h record; blocked boolean := false; constraint_name text;
BEGIN
  IF public.kustivo_discount_phone('0490 39 61 81') <> public.kustivo_discount_phone('+32 490 39 61 81')
    OR public.kustivo_discount_phone('0032 490 39 61 81') <> '0490396181' THEN
    RAISE EXCEPTION 'Phone normalization mismatch';
  END IF;
  IF has_function_privilege('anon','public.get_kustivo3_history(text)','EXECUTE')
    OR has_function_privilege('authenticated','public.get_kustivo3_history(text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.get_kustivo3_history(text)','EXECUTE') THEN
    RAISE EXCEPTION 'History permissions mismatch';
  END IF;
  INSERT INTO public.orders(order_number,customer_name,customer_phone,order_type,status,payment_status,payment_method,subtotal_cents,total_cents)
  OVERRIDING SYSTEM VALUE VALUES (-9000000000000001,'KUSTIVO3 transaction test','0000000000000994','pickup','completed','paid','online',2500,2500);
  SELECT * INTO h FROM public.get_kustivo3_history('0000 0000 0000 0994');
  IF h.completed_count <> 1 OR h.active_discount IS NOT NULL THEN RAISE EXCEPTION 'Completed history mismatch'; END IF;
  INSERT INTO public.orders(order_number,customer_name,customer_phone,order_type,status,payment_status,payment_method,subtotal_cents,total_cents,discount_code,discount_cents)
  OVERRIDING SYSTEM VALUE VALUES (-9000000000000002,'KUSTIVO3 transaction test','0000000000000994','pickup','pending_payment','unpaid','online',2500,2200,'KUSTIVO3',300);
  SELECT * INTO h FROM public.get_kustivo3_history('0000000000000994');
  IF h.active_discount IS NULL THEN RAISE EXCEPTION 'Pending checkout did not reserve code'; END IF;
  BEGIN
    INSERT INTO public.orders(order_number,customer_name,customer_phone,order_type,status,payment_status,payment_method,subtotal_cents,total_cents,discount_code,discount_cents)
    OVERRIDING SYSTEM VALUE VALUES (-9000000000000003,'KUSTIVO3 transaction test','0000 0000 0000 0994','pickup','new','unpaid','cash',2500,2200,'KUSTIVO3',300);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS constraint_name = CONSTRAINT_NAME;
    blocked := constraint_name = 'orders_kustivo3_phone_once';
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Duplicate coupon was not blocked'; END IF;
  UPDATE public.orders SET status='cancelled',payment_status='failed' WHERE order_number=-9000000000000002;
  SELECT * INTO h FROM public.get_kustivo3_history('0000000000000994');
  IF h.active_discount IS NOT NULL OR h.completed_count <> 1 THEN RAISE EXCEPTION 'Cancellation did not release code'; END IF;
  INSERT INTO public.orders(order_number,customer_name,customer_phone,order_type,status,payment_status,payment_method,subtotal_cents,total_cents,discount_code,discount_cents)
  OVERRIDING SYSTEM VALUE VALUES (-9000000000000004,'KUSTIVO3 transaction test','0000000000000994','pickup','completed','paid','cash',2500,2200,'KUSTIVO3',300);
  SELECT * INTO h FROM public.get_kustivo3_history('0000000000000994');
  IF h.active_discount IS NULL OR h.completed_count <> 2 THEN RAISE EXCEPTION 'Used code or second completion missing'; END IF;
  INSERT INTO public.orders(order_number,customer_name,customer_phone,order_type,status,payment_status,payment_method,subtotal_cents,total_cents)
  OVERRIDING SYSTEM VALUE VALUES (-9000000000000005,'KUSTIVO3 transaction test','0000000000000995','pickup','completed','unpaid','online',2500,2500),
    (-9000000000000006,'KUSTIVO3 transaction test','0000000000000996','pickup','completed','unpaid','cash',2500,2500);
  SELECT * INTO h FROM public.get_kustivo3_history('0000000000000995');
  IF h.completed_count <> 0 THEN RAISE EXCEPTION 'Unpaid online order incorrectly counted'; END IF;
  SELECT * INTO h FROM public.get_kustivo3_history('0000000000000996');
  IF h.completed_count <> 1 THEN RAISE EXCEPTION 'Completed cash order was not counted'; END IF;
END;
$$;
ROLLBACK;
SELECT 'KUSTIVO3 database checks passed; all fixture orders rolled back.' AS result;
