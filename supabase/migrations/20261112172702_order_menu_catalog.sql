create or replace function public.order_menu_catalog()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $catalog$
  select jsonb_build_object(
    'products', (
      select coalesce(jsonb_agg(to_jsonb(product) order by product.sort_order), '[]'::jsonb)
      from (
        select id, category, name, description, price_cents, regular_price_cents,
               offer_ends_at, image_path, sort_order, allergens_contains,
               allergens_may_contain, allergens_verified_at
        from public.order_products
      ) product
    ),
    'product_option_groups', (
      select coalesce(jsonb_agg(to_jsonb(link) order by link.sort_order), '[]'::jsonb)
      from (
        select product_id, group_id, sort_order
        from public.product_option_groups
      ) link
    ),
    'option_groups', (
      select coalesce(jsonb_agg(to_jsonb(option_group) order by option_group.sort_order), '[]'::jsonb)
      from (
        select id, title, subtitle, input_type, required, max_select,
               display_prefix, sort_order
        from public.option_groups
      ) option_group
    ),
    'option_values', (
      select coalesce(jsonb_agg(to_jsonb(option_value) order by option_value.sort_order), '[]'::jsonb)
      from (
        select group_id, label, price_delta_cents, active, sort_order,
               allergens_contains, allergens_may_contain, allergens_verified_at
        from public.option_values
        where active = true
      ) option_value
    )
  );
$catalog$;

revoke all on function public.order_menu_catalog() from public;
grant execute on function public.order_menu_catalog() to anon, authenticated;
