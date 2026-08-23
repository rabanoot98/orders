alter table public.order_items
  add column if not exists fulfilled boolean not null default false;
