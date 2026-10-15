-- Allergen information from the owner-supplied Oresto technical sheet 2201602.pdf.
-- Product: peeled/deveined Vannamei 16/20, EAN 5420053206092.
-- Supplier document date: 2020-12-09; reviewed on 2026-10-15.
-- Page 1 lists shrimp under allergen information; no other allergens or
-- may-contain warnings are declared in that sheet. An empty may-contain array
-- means no supplier warning was reported, not a guarantee against cross-contact.
-- This is a review of the supplied specification, not an independent inspection
-- of the current bag. Recheck the current label when the supplied product changes.
-- The pizza base already has verified wheat, soy and milk. Extra toppings and
-- sauces retain their own review status; complete deals are not marked verified.

BEGIN;
DO $scampi$
DECLARE
  base_contains text[];
  base_may_contain text[];
  changed integer;
  checked_at timestamptz := now();
  pizza_contains text[] := ARRAY['wheat','crustaceans','soy','milk']::text[];
BEGIN
  SELECT allergens_contains, allergens_may_contain
    INTO base_contains, base_may_contain
    FROM public.products
   WHERE id = 'margherita' AND allergens_verified_at IS NOT NULL;
  IF base_contains IS NULL OR base_may_contain IS NULL
     OR NOT (base_contains @> ARRAY['wheat','soy','milk']::text[]
             AND base_contains <@ ARRAY['wheat','soy','milk']::text[]) THEN
    RAISE EXCEPTION 'The confirmed pizza base has changed; review before applying';
  END IF;

  UPDATE public.products
     SET allergens_contains = pizza_contains,
         allergens_may_contain = base_may_contain,
         allergens_verified_at = checked_at
   WHERE id = 'scampi-pizza' AND active
     AND description = 'Tomatensaus, kaas en scampi.'
     AND allergens_verified_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Expected one unreviewed scampi pizza, found %', changed;
  END IF;

  UPDATE public.option_values
     SET allergens_contains = ARRAY['crustaceans']::text[],
         allergens_may_contain = ARRAY[]::text[],
         allergens_verified_at = checked_at
   WHERE group_id = 'pizzaToppings' AND value_code = 'extra_scampi'
     AND allergens_verified_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Expected one unreviewed scampi topping, found %', changed;
  END IF;

  UPDATE public.option_values
     SET allergens_contains = pizza_contains,
         allergens_may_contain = base_may_contain,
         allergens_verified_at = checked_at
   WHERE value_code = 'scampi'
     AND group_id IN ('dealPizza','dealPizza1','dealPizza2','duoPizza1','duoPizza2',
                      'familyPizza1','familyPizza2','familyPizza3')
     AND allergens_verified_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 8 THEN
    RAISE EXCEPTION 'Expected eight unreviewed scampi pizza choices, found %', changed;
  END IF;
END;
$scampi$;
COMMIT;
