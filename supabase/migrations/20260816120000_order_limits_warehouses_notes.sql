-- ============================================================
-- מיגרציה 07 — מחסנים דינמיים, מגבלת הזמנה והערות מנהל
-- ============================================================

-- מחסנים ניתנים לניהול במקום רשימה קשיחה בקוד.
create table if not exists public.warehouses (
  id         text primary key,
  label      text not null,
  icon       text not null default '📦',
  sub        text not null default 'הזמנת ציוד',
  noun       text not null default 'מוצרים',
  active     boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint warehouses_id_format check (id ~ '^[a-z0-9][a-z0-9_-]{1,49}$')
);

insert into public.warehouses (id, label, icon, sub, noun, sort_order) values
  ('main', 'מחסן דת', '📦', 'הזמנת ציוד דת', 'מוצרים', 10),
  ('zuk', 'ציוד זו"ק', '🪖', 'מחסן זוק', 'ציוד', 20),
  ('holidays', 'מחסן חגים', '🕎', 'ציוד לחגים', 'ציוד', 30)
on conflict (id) do update set
  label = excluded.label,
  icon = excluded.icon,
  sub = excluded.sub,
  noun = excluded.noun;

-- מסירים את רשימת המחסנים הקשיחה ומחליפים אותה בקשר לטבלת המחסנים.
do $$
declare c record;
begin
  for c in
    select conrelid::regclass as tbl, conname
      from pg_constraint
     where conrelid in ('public.inventory'::regclass, 'public.orders'::regclass)
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%warehouse%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.inventory
  drop constraint if exists inventory_warehouse_fkey,
  add constraint inventory_warehouse_fkey foreign key (warehouse)
    references public.warehouses(id) on update cascade;

alter table public.orders
  drop constraint if exists orders_warehouse_fkey,
  add constraint orders_warehouse_fkey foreign key (warehouse)
    references public.warehouses(id) on update cascade;

alter table public.warehouses enable row level security;

drop policy if exists "warehouses_select" on public.warehouses;
create policy "warehouses_select" on public.warehouses
  for select to authenticated using (active or public.is_admin());

drop policy if exists "warehouses_admin_all" on public.warehouses;
create policy "warehouses_admin_all" on public.warehouses
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- NULL = ללא הגבלה נוספת (המלאי הזמין נשאר התקרה).
alter table public.inventory
  add column if not exists max_order_qty integer;

alter table public.inventory
  drop constraint if exists inventory_max_order_qty_check,
  add constraint inventory_max_order_qty_check
    check (max_order_qty is null or max_order_qty > 0);

alter table public.orders
  add column if not exists admin_note text;

alter table public.orders
  drop constraint if exists orders_admin_note_length,
  add constraint orders_admin_note_length
    check (admin_note is null or length(admin_note) <= 1000);

-- אכיפה בצד השרת: לקוח לא יכול לעקוף את המגבלה דרך קריאת API ידנית.
create or replace function public.enforce_order_item_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_wh     text;
  v_stock  integer;
  v_limit  integer;
begin
  -- מנהל רשאי לתקן הזמנה ידנית גם מעבר למגבלת הלקוח.
  if public.is_admin() then
    return new;
  end if;

  select warehouse into v_wh
    from public.orders
   where id = new.order_id and user_id = auth.uid();

  if v_wh is null then
    raise exception 'ההזמנה לא נמצאה או אינה שייכת למשתמש';
  end if;

  select qty, max_order_qty into v_stock, v_limit
    from public.inventory
   where warehouse = v_wh and name = new.name and exposed = true;

  if v_stock is null then
    raise exception 'המוצר "%" אינו זמין להזמנה', new.name;
  end if;

  if new.qty > least(v_stock, coalesce(v_limit, v_stock)) then
    raise exception 'הכמות עבור "%" גבוהה מהמקסימום המותר', new.name;
  end if;

  return new;
end $$;

drop trigger if exists order_items_limit_guard on public.order_items;
create trigger order_items_limit_guard
  before insert or update of qty, name, order_id on public.order_items
  for each row execute function public.enforce_order_item_limit();

grant select on public.warehouses to authenticated;
grant insert, update, delete on public.warehouses to authenticated;

