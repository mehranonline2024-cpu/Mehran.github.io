-- KUSTIVO3: EUR 3 on a second order, EUR 25 product minimum.
-- Keep normalization aligned with create-checkout/normalizePhone.
CREATE OR REPLACE FUNCTION public.kustivo_discount_phone(p_phone text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  WITH digits AS (
    SELECT pg_catalog.regexp_replace(pg_catalog.left(pg_catalog.btrim(COALESCE(p_phone, '')), 40), '[^0-9]', '', 'g') AS n
  )
  SELECT CASE WHEN n LIKE '0032%' THEN '0' || pg_catalog.substr(n, 5)
    WHEN n LIKE '32%' AND pg_catalog.length(n) = 11 THEN '0' || pg_catalog.substr(n, 3)
    ELSE n END FROM digits;
$$;

CREATE INDEX IF NOT EXISTS orders_kustivo_phone_history_idx
ON public.orders (public.kustivo_discount_phone(customer_phone));

-- Reserve the discount when the order is created, including while payment is open.
-- Cancelled/rejected/failed/refunded orders release it. This also prevents two
-- simultaneous requests from using the same discount with different phone formats.
CREATE UNIQUE INDEX IF NOT EXISTS orders_kustivo3_phone_once
ON public.orders (public.kustivo_discount_phone(customer_phone))
WHERE discount_code = 'KUSTIVO3'
  AND status NOT IN ('cancelled', 'rejected')
  AND payment_status NOT IN ('failed', 'refunded');

CREATE OR REPLACE FUNCTION public.get_kustivo3_history(p_phone text)
RETURNS TABLE (completed_count bigint, active_discount jsonb)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    (SELECT count(*) FROM public.orders o
      WHERE public.kustivo_discount_phone(o.customer_phone) = public.kustivo_discount_phone(p_phone)
        AND o.status = 'completed'
        AND (o.payment_status = 'paid' OR (o.payment_method = 'cash' AND o.payment_status = 'unpaid'))),
    (SELECT pg_catalog.jsonb_build_object('id', o.id, 'status', o.status,
        'paymentStatus', o.payment_status, 'paymentMethod', o.payment_method,
        'sessionId', o.stripe_checkout_session_id)
      FROM public.orders o
      WHERE public.kustivo_discount_phone(o.customer_phone) = public.kustivo_discount_phone(p_phone)
        AND o.discount_code = 'KUSTIVO3'
        AND o.status NOT IN ('cancelled', 'rejected')
        AND o.payment_status NOT IN ('failed', 'refunded')
      LIMIT 1);
$$;

-- Order history is available only to the server; keep existing order RLS intact.
REVOKE ALL ON FUNCTION public.get_kustivo3_history(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_kustivo3_history(text) TO service_role;
