alter table public.order_items drop constraint if exists order_items_qty_check;
alter table public.order_items add constraint order_items_qty_check check (qty >= 0);

alter table public.profiles add column if not exists blocked_at timestamptz;
