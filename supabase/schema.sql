-- ============================================================
-- מערכת הזמנות ציוד דת — סכימת Supabase
-- הרץ את הקובץ הזה פעם אחת ב-Supabase → SQL Editor
-- ============================================================

-- ── פרופילים (מרחיב את auth.users) ──────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  initials    text,                       -- שם בראשי תיבות (לדוגמא ד.כ)
  phone       text,
  role        text not null default 'user' check (role in ('user','admin')),
  is_guest    boolean not null default false,
  blocked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── מלאי (שני המחסנים בטבלה אחת) ────────────────────────────
create table if not exists public.inventory (
  id          bigint generated always as identity primary key,
  warehouse   text not null check (warehouse in ('main','zuk')),
  name        text not null,
  qty         integer not null default 0 check (qty >= 0),
  category    text default 'כללי',
  exposed     boolean not null default true,   -- האם מוצג להזמנה
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (warehouse, name)
);

create index if not exists inventory_wh_exposed_idx on public.inventory (warehouse, exposed);

-- ── הזמנות ──────────────────────────────────────────────────
create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete set null,
  initials     text not null,
  phone        text not null,
  email        text,                                   -- מייל ליצירת קשר (לעדכון "מוכנה לאיסוף")
  warehouse    text not null check (warehouse in ('main','zuk')),
  status       text not null default 'pending' check (status in ('pending','ready','collected')),
  cert_mode    text not null default 'at_pickup' check (cert_mode in ('uploaded','at_pickup')),
  cert_path    text,                                   -- נתיב קובץ תעודת הספק ב-Storage
  is_guest     boolean not null default false,
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  notified_at  timestamptz                             -- מתי נשלח מייל "מוכנה לאיסוף"
);

create index if not exists orders_user_idx    on public.orders (user_id);
create index if not exists orders_status_idx  on public.orders (status, created_at desc);

-- ── פריטי הזמנה ─────────────────────────────────────────────
create table if not exists public.order_items (
  id        bigint generated always as identity primary key,
  order_id  uuid not null references public.orders(id) on delete cascade,
  name      text not null,
  qty       integer not null check (qty >= 0)
);

create index if not exists order_items_order_idx on public.order_items (order_id);

-- ============================================================
-- עדכון אוטומטי של updated_at
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists inventory_touch on public.inventory;
create trigger inventory_touch before update on public.inventory
  for each row execute function public.touch_updated_at();

-- ============================================================
-- יצירת פרופיל אוטומטית בהרשמה + הגדרת המנהל
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, is_guest)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    case when lower(coalesce(new.email,'')) = 'rabanoot98@gmail.com' then 'admin' else 'user' end,
    coalesce(new.is_anonymous, false)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- בדיקת הרשאת מנהל
-- ============================================================
create or replace function public.is_admin()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ============================================================
-- הרשאות שורה (RLS)
-- ============================================================
alter table public.profiles    enable row level security;
alter table public.inventory   enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

-- פרופילים
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update" on public.profiles
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- מלאי: כל מחובר רואה פריטים חשופים; מנהל רואה ומנהל הכול
drop policy if exists "inventory_select" on public.inventory;
create policy "inventory_select" on public.inventory
  for select to authenticated
  using (exposed = true or public.is_admin());

drop policy if exists "inventory_admin_all" on public.inventory;
create policy "inventory_admin_all" on public.inventory
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- הזמנות
drop policy if exists "orders_select" on public.orders;
create policy "orders_select" on public.orders
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "orders_insert_own" on public.orders;
create policy "orders_insert_own" on public.orders
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "orders_admin_write" on public.orders;
create policy "orders_admin_write" on public.orders
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "orders_admin_delete" on public.orders;
create policy "orders_admin_delete" on public.orders
  for delete to authenticated using (public.is_admin());

-- מאפשר למשתמש לצרף תעודת ספק להזמנה שלו (עדכון cert בלבד, כל עוד ממתינה)
drop policy if exists "orders_owner_attach_cert" on public.orders;
create policy "orders_owner_attach_cert" on public.orders
  for update to authenticated
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'pending');

-- פריטי הזמנה
drop policy if exists "order_items_select" on public.order_items;
create policy "order_items_select" on public.order_items
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())
  ));

drop policy if exists "order_items_insert" on public.order_items;
create policy "order_items_insert" on public.order_items
  for insert to authenticated
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and o.user_id = auth.uid()
  ));

drop policy if exists "order_items_admin_write" on public.order_items;
create policy "order_items_admin_write" on public.order_items
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- אחסון: תעודות ספק (PDF)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('supplier-certs', 'supplier-certs', false)
on conflict (id) do nothing;

drop policy if exists "certs_upload" on storage.objects;
create policy "certs_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'supplier-certs');

drop policy if exists "certs_read" on storage.objects;
create policy "certs_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'supplier-certs' and (owner = auth.uid() or public.is_admin()));

drop policy if exists "certs_admin_delete" on storage.objects;
create policy "certs_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'supplier-certs' and public.is_admin());

-- ============================================================
-- אישור הזמנה + הורדת מלאי (אטומי, מונע הורדה כפולה)
-- ============================================================
create or replace function public.approve_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_wh      text;
  v_status  text;
  v_rec     record;
  v_new     integer;
  v_results jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה — פעולה זו מותרת למנהל בלבד';
  end if;

  select warehouse, status into v_wh, v_status
    from public.orders where id = p_order_id for update;

  if v_wh is null then
    raise exception 'ההזמנה לא נמצאה';
  end if;
  if v_status <> 'pending' then
    raise exception 'ההזמנה כבר אושרה';
  end if;

  for v_rec in select name, qty from public.order_items where order_id = p_order_id loop
    v_new := null;
    update public.inventory
       set qty = greatest(0, qty - v_rec.qty)
     where warehouse = v_wh and name = v_rec.name
     returning qty into v_new;

    if v_new is null then
      v_results := v_results || jsonb_build_object('name', v_rec.name, 'notFound', true);
    else
      v_results := v_results || jsonb_build_object('name', v_rec.name, 'newStock', v_new);
    end if;
  end loop;

  update public.orders
     set status = 'ready', approved_at = now()
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'results', v_results);
end $$;

-- ============================================================
-- קליטת סחורה: מוסיף לקיים או יוצר חדש
-- ============================================================
create or replace function public.receive_goods(
  p_warehouse text,
  p_name      text,
  p_qty       integer,
  p_category  text default null,
  p_exposed   boolean default true
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing integer;
  v_new      integer;
  v_name     text := btrim(p_name);
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה — פעולה זו מותרת למנהל בלבד';
  end if;
  if v_name is null or v_name = '' then
    raise exception 'חסר שם מוצר';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'יש להזין כמות חיובית';
  end if;

  select qty into v_existing from public.inventory
   where warehouse = p_warehouse and name = v_name;

  if v_existing is null then
    insert into public.inventory (warehouse, name, qty, category, exposed)
    values (p_warehouse, v_name, p_qty, coalesce(nullif(p_category,''),'כללי'), p_exposed)
    returning qty into v_new;
    return jsonb_build_object('ok', true, 'created', true, 'name', v_name, 'newStock', v_new);
  end if;

  update public.inventory
     set qty      = qty + p_qty,
         category = coalesce(nullif(p_category,''), category),
         exposed  = p_exposed
   where warehouse = p_warehouse and name = v_name
   returning qty into v_new;

  return jsonb_build_object('ok', true, 'created', false, 'name', v_name, 'newStock', v_new);
end $$;

-- ============================================================
-- הרשאות הרצה
-- ============================================================
grant execute on function public.approve_order(uuid)                              to authenticated;
grant execute on function public.receive_goods(text, text, integer, text, boolean) to authenticated;
grant execute on function public.is_admin()                                        to authenticated;
