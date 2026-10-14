-- Topping prices for the build-your-own pizza only.
-- Extra cheese stays at its existing price; keep the five-topping limit.
WITH requested(value_code,price_cents) AS (VALUES
 ('extra_mushrooms',100),('extra_olives',100),('extra_onion',100),('extra_jalapeno',100),
 ('extra_pepper',150),('extra_pineapple',150),
 ('extra_chicken',200),('extra_pepperoni',200),('extra_tuna',200),('extra_ham',200),
 ('extra_scampi',400),('extra_doner',300)
)
UPDATE public.option_values v SET price_delta_cents=requested.price_cents
FROM requested WHERE v.group_id='pizzaToppings' AND v.value_code=requested.value_code
RETURNING v.value_code,v.label,v.price_delta_cents;
