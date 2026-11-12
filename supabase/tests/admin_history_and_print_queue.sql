-- Transactional integration check: all sample orders, events and jobs roll back.
begin;
do $$
declare
  admin_id uuid;
  finished_id uuid:=gen_random_uuid();
  cash_id uuid:=gen_random_uuid();
  online_id uuid:=gen_random_uuid();
  base_no bigint:=-(1000000000+floor(random()*1000000000)::bigint);
  row_count integer;
  job_payload jsonb;
begin
  select user_id into admin_id from public.restaurant_admins limit 1;
  assert admin_id is not null, 'An existing restaurant admin is required';
  insert into public.orders(id,order_number,customer_name,customer_phone,order_type,status,payment_method,payment_status,subtotal_cents,total_cents,requested_time)
  overriding system value values
    (finished_id,base_no,'TEST rollback history','0000000000','pickup','completed','cash','paid',400,400,'TEST'),
    (cash_id,base_no-1,'TEST rollback printer','0000000000','pickup','new','cash','unpaid',800,800,'TEST'),
    (online_id,base_no-2,'TEST rollback unpaid','0000000000','pickup','new','online','unpaid',400,400,'TEST');
  insert into public.order_items(order_id,product_name,quantity,unit_price_cents,line_total_cents,details,item_note)
  values(cash_id,'TEST Bici Burger',2,400,800,'["TEST saus apart"]','TEST zonder ui');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated','aal','aal2')::text,true);
  execute 'set local role authenticated';
  update public.orders set admin_hidden_at=now() where id=finished_id;
  get diagnostics row_count=row_count;
  assert row_count=1, 'MFA admin must be able to hide completed history';
  assert (select total_cents=400 and payment_status='paid' and status='completed' from public.orders where id=finished_id), 'Hiding must preserve financial and status data';
  update public.orders set admin_hidden_at=null where id=finished_id;
  assert (select admin_hidden_at is null from public.orders where id=finished_id), 'History restoration must work';
  begin
    update public.orders set admin_hidden_at=now() where id=cash_id;
    raise exception 'Active order was incorrectly hidden';
  exception when check_violation then null;
  end;

  update public.orders set status='accepted' where id=cash_id;
  assert (select count(*)=1 from public.printer_jobs where order_id=cash_id and status='queued'), 'Cash acceptance must queue exactly one receipt';
  select payload into job_payload from public.printer_jobs where order_id=cash_id;
  assert job_payload->'items'->0->>'name'='TEST Bici Burger', 'Receipt product missing';
  assert (job_payload->'items'->0->>'quantity')::integer=2, 'Receipt quantity missing';
  assert job_payload->'items'->0->>'item_note'='TEST zonder ui', 'Receipt item note missing';
  assert (job_payload->>'total_cents')::integer=800, 'Receipt total missing';
  update public.orders set status='accepted' where id=cash_id;
  assert (select count(*)=1 from public.printer_jobs where order_id=cash_id), 'Repeated acceptance must not duplicate the receipt';
  update public.printer_jobs set status='cancelled' where order_id=cash_id;
  update public.printer_jobs set status='queued' where order_id=cash_id;
  assert (select status='queued' from public.printer_jobs where order_id=cash_id), 'Skipped receipts must support reprint';
  update public.orders set status='accepted' where id=online_id;
  assert not exists(select 1 from public.printer_jobs where order_id=online_id), 'Unpaid online order must not queue a receipt';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated','aal','aal1')::text,true);
  update public.orders set admin_hidden_at=now() where id=finished_id;
  get diagnostics row_count=row_count;
  assert row_count=0, 'Password-only session must not change history';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated','aal','aal2')::text,true);
  update public.orders set admin_hidden_at=now() where id=finished_id;
  get diagnostics row_count=row_count;
  assert row_count=0, 'Non-admin must not change history';
  execute 'set local role anon';
  perform set_config('request.jwt.claims','{}',true);
  begin
    update public.orders set admin_hidden_at=now() where id=finished_id;
    raise exception 'Anonymous history write was incorrectly allowed';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
end $$;
rollback;
select 'PASS: history hide/restore, financial preservation, MFA and non-admin restrictions, acceptance receipt payload, unpaid online guard and duplicate prevention; all samples rolled back' as result;
