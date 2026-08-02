-- ============================================================
-- מיגרציה 04 — הוספת "מחסן חגים"
-- מרחיב את אילוצי המחסן ב-inventory וב-orders
-- ============================================================

-- הסרת אילוצי ה-CHECK הקיימים על עמודת warehouse
-- (השם נוצר אוטומטית ע"י Postgres, לכן מאתרים לפי ההגדרה)
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
  add constraint inventory_warehouse_check
  check (warehouse in ('main', 'zuk', 'holidays'));

alter table public.orders
  add constraint orders_warehouse_check
  check (warehouse in ('main', 'zuk', 'holidays'));
