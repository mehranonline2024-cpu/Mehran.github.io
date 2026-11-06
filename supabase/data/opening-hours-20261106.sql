-- Kustivo: first available pick-up/delivery slot at 11:30 (Europe/Brussels).
UPDATE public.store_settings SET opens_at = TIME '11:30' WHERE id = 'main';
