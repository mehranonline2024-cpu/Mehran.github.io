-- Shared, reversible history visibility. Existing admin + MFA RLS still applies.
alter table public.orders add column admin_hidden_at timestamptz;
alter table public.orders add constraint orders_hidden_history_only check (
  admin_hidden_at is null or (
    status in ('completed','rejected','cancelled')
    and not (status='rejected' and payment_method='online' and payment_status='paid')
  )
);
grant update (admin_hidden_at) on public.orders to authenticated;
comment on column public.orders.admin_hidden_at is 'Hidden from the normal admin history; order and financial records are retained. Terminal orders only.';

-- Old pending receipts may be skipped explicitly and offered again via reprint.
alter table public.printer_jobs drop constraint printer_jobs_status_check;
alter table public.printer_jobs add constraint printer_jobs_status_check
  check (status in ('queued','printing','printed','failed','cancelled'));
