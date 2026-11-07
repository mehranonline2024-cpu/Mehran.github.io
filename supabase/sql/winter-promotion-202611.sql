-- Advertised products that have no matching active item in the regular catalogue.
INSERT INTO public.products
  (id, category, name, description, price_cents, image_path, sort_order)
VALUES
  ('winter-bici-burger', 'Grill Time Classics', 'Bici Burger',
   'Sappige burger met kaas en frisse sla op een geroosterd broodje.', 600, '', 205),
  ('winter-durum-kebab', 'Grill Time Classics', 'Dürum Kebab',
   'Strak gerolde wrap bomvol mals vlees en verse salade.', 1000, '../Wrap.jfif', 206),
  ('winter-pita-kebab', 'Grill Time Classics', 'Pita Kebab',
   'Traditioneel pitabroodje, rijkelijk gevuld met gekruid vlees en verse salade.', 1000, '', 207);

INSERT INTO public.product_option_groups (product_id, group_id, sort_order)
SELECT offers.id, options.group_id, options.sort_order
FROM (VALUES ('winter-durum-kebab', 'durum'), ('winter-pita-kebab', 'pita')) AS offers(id, base_id)
JOIN public.product_option_groups AS options ON options.product_id = offers.base_id
WHERE options.group_id IN ('sauces', 'vegetables');

-- Menu and checkout use the same effective prices. Base prices stay on products.
-- The three flyer-only items are available through 25 November in Belgium.
CREATE VIEW public.order_products WITH (security_invoker = true) AS
WITH campaign AS (
  SELECT TIMESTAMPTZ '2026-11-26 00:00:00 Europe/Brussels' AS ends_at
)
SELECT
  p.id, p.category, p.name, p.description, p.image_path, p.sort_order, p.active,
  p.allergens_contains, p.allergens_may_contain, p.allergens_verified_at,
  COALESCE(offer.price_cents, p.price_cents) AS price_cents,
  p.price_cents AS regular_price_cents,
  CASE WHEN offer.price_cents IS NOT NULL THEN campaign.ends_at END AS offer_ends_at
FROM public.products AS p
CROSS JOIN campaign
CROSS JOIN LATERAL (
  SELECT CASE WHEN CURRENT_TIMESTAMP < campaign.ends_at AND p.category <> 'Drinks' THEN
    CASE p.id
      WHEN 'margherita' THEN 890
      WHEN 'pepperoni' THEN 1090
      WHEN 'loaded-doner-pizza' THEN 1190
      WHEN 'winter-bici-burger' THEN 400
      WHEN 'winter-durum-kebab' THEN 700
      WHEN 'winter-pita-kebab' THEN 700
      ELSE CASE WHEN p.price_cents > 200 THEN p.price_cents - 200 END
    END
  END AS price_cents
) AS offer
WHERE p.active AND p.availability_status <> 'hidden'
  AND (CURRENT_TIMESTAMP < campaign.ends_at OR p.id NOT IN
    ('winter-bici-burger', 'winter-durum-kebab', 'winter-pita-kebab'));

REVOKE ALL ON public.order_products FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_products TO anon, authenticated, service_role;
