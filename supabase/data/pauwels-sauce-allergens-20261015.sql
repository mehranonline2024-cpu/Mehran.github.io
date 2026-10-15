-- Pauwels Professional allergen information reviewed on 2026-10-15.
-- The owner confirmed Pauwels sauces, regular Andalouse (not Chef), and halal
-- products, including the Cocktail Halal variant, in the current conversation.
-- This records supplier allergen declarations, not halal certification.
-- No unreviewed meat, snack or complete recipe is marked verified by this file.
-- Empty may-contain arrays mean no additional supplier warning was declared;
-- they are not a guarantee against kitchen cross-contact.
-- Supplier sources:
-- https://www.pauwels-sauces.be/nl-BE/sauzen/mayonaise/mayonaise/10l-emmer
-- https://www.pauwels-sauces.be/nl-BE/sauzen/speciaalsauzen/andalouse/10l-emmer
-- https://www.pauwels-sauces.be/nl-BE/sauzen/speciaalsauzen/samurai/10l-emmer
-- https://www.pauwels-sauces.be/sauzen/speciaalsauzen/look/10l-emmer
-- https://www.pauwels-sauces.be/nl-BE/sauzen/ketchup/curryketchup/10l-emmer
-- https://www.pauwels-sauces.be/nl-BE/sauzen/ketchup/ketchup/10l-emmer
-- https://www.pauwels-sauces.be/sauzen/speciaalsauzen/cocktailsaus-halal/10l-emmer

BEGIN;
DO $pauwels$
DECLARE
  changed integer;
BEGIN
  WITH supplier(value_code, contains_codes, may_contain_codes) AS (
    VALUES
      ('mayonaise', ARRAY['eggs','mustard']::text[], ARRAY[]::text[]),
      ('andalouse', ARRAY['eggs','mustard']::text[], ARRAY[]::text[]),
      ('samurai', ARRAY['eggs','mustard']::text[], ARRAY[]::text[]),
      ('look', ARRAY['eggs','mustard']::text[], ARRAY[]::text[]),
      ('curry-ketchup', ARRAY['mustard']::text[], ARRAY[]::text[]),
      ('ketchup', ARRAY[]::text[], ARRAY['mustard']::text[]),
      ('cocktail', ARRAY['eggs']::text[], ARRAY['mustard']::text[])
  )
  UPDATE public.option_values AS option
     SET allergens_contains = supplier.contains_codes,
         allergens_may_contain = supplier.may_contain_codes,
         allergens_verified_at = now()
    FROM supplier
   WHERE option.group_id IN ('sauces','burgerSauce')
     AND option.value_code = supplier.value_code
     AND option.allergens_verified_at IS NULL
     AND option.allergens_contains IS NULL
     AND option.allergens_may_contain IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 14 THEN
    RAISE EXCEPTION 'Expected fourteen unreviewed sauce options, found %; review before applying', changed;
  END IF;
END;
$pauwels$;
COMMIT;
