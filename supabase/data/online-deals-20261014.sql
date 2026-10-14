-- Live menu configuration for the three online deals.
-- Keep all existing photos and existing pizza surcharges.
BEGIN;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.products WHERE
    (id='pizza-menu' AND price_cents=1599) OR
    (id='duo-pizza-deal' AND price_cents IN (2198,2799)) OR
    (id='family-deal' AND price_cents IN (3990,4400)))<>3 THEN
    RAISE EXCEPTION 'Online deal prices changed; review the current menu before applying';
  END IF;
END $$;

INSERT INTO public.option_groups (id,title,subtitle,input_type,required,max_select,display_prefix,sort_order)
VALUES
 ('familyPizza3','Kies pizza 3','','radio',true,1,'',30),
 ('dealSide1','Kies side 1','','radio',true,1,'',40),
 ('dealSide2','Kies side 2','','radio',true,1,'',45),
 ('dealDrink3','Kies drankje 3','','radio',true,1,'',70)
ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,input_type=EXCLUDED.input_type,required=EXCLUDED.required,max_select=EXCLUDED.max_select,sort_order=EXCLUDED.sort_order;

INSERT INTO public.option_values (group_id,value_code,label,price_delta_cents,active,sort_order,availability_status,sold_out_on,allergens_contains,allergens_may_contain,allergens_verified_at)
SELECT 'familyPizza3',value_code,label,price_delta_cents,active,sort_order,availability_status,sold_out_on,allergens_contains,allergens_may_contain,allergens_verified_at
FROM public.option_values WHERE group_id='familyPizza1'
ON CONFLICT (group_id,value_code) DO UPDATE SET label=EXCLUDED.label,price_delta_cents=EXCLUDED.price_delta_cents,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order;

INSERT INTO public.option_values (group_id,value_code,label,price_delta_cents,active,sort_order,availability_status,sold_out_on,allergens_contains,allergens_may_contain,allergens_verified_at)
SELECT 'dealDrink3',value_code,label,price_delta_cents,active,sort_order,availability_status,sold_out_on,allergens_contains,allergens_may_contain,allergens_verified_at
FROM public.option_values WHERE group_id='dealDrink1'
ON CONFLICT (group_id,value_code) DO UPDATE SET label=EXCLUDED.label,price_delta_cents=EXCLUDED.price_delta_cents,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order;

INSERT INTO public.option_values (group_id,value_code,label,price_delta_cents,active,sort_order)
SELECT sides.group_id,choice.code,choice.label,0,true,choice.sort_order
FROM (VALUES ('dealSide1'),('dealSide2')) AS sides(group_id)
CROSS JOIN (VALUES
 ('small-fries','Kleine friet',10),
 ('nuggets-4','4 nuggets',20),
 ('frikandel-1','1 frikandel',30),
 ('wings-3','3 chicken wings',40)
) AS choice(code,label,sort_order)
ON CONFLICT (group_id,value_code) DO UPDATE SET label=EXCLUDED.label,price_delta_cents=EXCLUDED.price_delta_cents,sort_order=EXCLUDED.sort_order;

INSERT INTO public.product_option_groups (product_id,group_id,sort_order)
VALUES
 ('pizza-menu','dealPizza',10),('pizza-menu','dealSide1',40),('pizza-menu','softDrink',50),
 ('duo-pizza-deal','duoPizza1',10),('duo-pizza-deal','duoPizza2',20),('duo-pizza-deal','dealSide1',40),('duo-pizza-deal','dealDrink1',50),('duo-pizza-deal','dealDrink2',60),
 ('family-deal','familyPizza1',10),('family-deal','familyPizza2',20),('family-deal','familyPizza3',30),('family-deal','dealSide1',40),('family-deal','dealSide2',45),('family-deal','dealDrink1',50),('family-deal','dealDrink2',60),('family-deal','dealDrink3',70)
ON CONFLICT (product_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order;

UPDATE public.products SET name='Pizza Menu + Side + Drank',description='1 Regular pizza + 1 side naar keuze + 1 frisdrank (330 ml). Margherita inbegrepen; Regina + €1,50; overige pizza’s + €2 per pizza.',price_cents=1599 WHERE id='pizza-menu';
UPDATE public.products SET name='Duo Pizza Deal + Side + 2 Dranken',description='2 Regular pizza’s + 1 side naar keuze + 2 frisdranken (330 ml). Margherita inbegrepen; Regina + €1,50; overige pizza’s + €2 per pizza.',price_cents=2799 WHERE id='duo-pizza-deal';
UPDATE public.products SET name='Grill Time Family Deal',description='3 Regular pizza’s + 2 sides naar keuze + 3 frisdranken (330 ml). Margherita inbegrepen; Regina + €1,50; overige pizza’s + €2 per pizza.',price_cents=4400 WHERE id='family-deal';
UPDATE public.products SET price_cents=1190 WHERE id='regina';
UPDATE public.products SET price_cents=1590 WHERE id='scampi-pizza';
UPDATE public.option_values SET price_delta_cents=CASE value_code WHEN 'margherita' THEN 0 WHEN 'regina' THEN 150 ELSE 200 END WHERE group_id IN ('dealPizza','duoPizza1','duoPizza2','familyPizza1','familyPizza2','familyPizza3');
UPDATE public.products SET image_path='/assets/images/family-deal-three-pizzas-20261014.jpg' WHERE id='family-deal';
COMMIT;

SELECT p.id,p.name,p.price_cents,json_agg(json_build_object('group',g.id,'required',g.required,'max_select',g.max_select,'choices',(SELECT count(*) FROM public.option_values v WHERE v.group_id=g.id AND v.active)) ORDER BY link.sort_order) AS choices
FROM public.products p JOIN public.product_option_groups link ON link.product_id=p.id JOIN public.option_groups g ON g.id=link.group_id
WHERE p.id IN ('pizza-menu','duo-pizza-deal','family-deal') GROUP BY p.id,p.name,p.price_cents;
