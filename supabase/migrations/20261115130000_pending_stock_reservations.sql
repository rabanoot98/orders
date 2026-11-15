-- Pending orders reserve inventory. Ready orders have already deducted it.
-- Lock inventory before checking reservations, including writes from older clients.
create index if not exists order_items_stock_lookup_idx on public.order_items(name, warehouse, order_id);

create or replace function public.get_available_inventory(p_warehouse text default null)
returns table (
  id bigint, warehouse text, name text, qty integer, reserved_qty bigint,
  available_qty bigint, category text, exposed boolean, max_order_qty integer, sort_order integer
)
language sql stable security definer set search_path = public
as $$
  select i.id, i.warehouse, i.name, i.qty, coalesce(r.qty, 0),
    greatest(0, i.qty - coalesce(r.qty, 0)), i.category, i.exposed, i.max_order_qty, i.sort_order
  from public.inventory i
  left join (
    select coalesce(oi.warehouse, o.warehouse) as warehouse, oi.name, sum(oi.qty) as qty
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where o.status = 'pending'
    group by coalesce(oi.warehouse, o.warehouse), oi.name
  ) r on r.warehouse = i.warehouse and r.name = i.name
  where auth.uid() is not null and (p_warehouse is null or i.warehouse = p_warehouse)
    and (public.is_admin() or (i.exposed and exists (
      select 1 from public.warehouses w where w.id = i.warehouse and w.active
    )))
  order by i.warehouse, i.sort_order, i.name;
$$;

create or replace function public.enforce_order_item_limit()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_wh text; v_stock integer; v_limit integer; v_exposed boolean;
  v_reserved bigint; v_order_qty bigint; v_old_id bigint;
begin
  select * into v_order from public.orders where id = new.order_id for update;
  if not found then raise exception 'ההזמנה לא נמצאה'; end if;
  if not public.is_admin() and (v_order.user_id is distinct from auth.uid() or v_order.status <> 'pending') then
    raise exception 'אין הרשאה לערוך את ההזמנה';
  end if;
  v_wh := coalesce(new.warehouse, v_order.warehouse);
  if not public.is_admin() and v_wh <> v_order.warehouse then
    raise exception 'הפריט אינו שייך למחסן ההזמנה';
  end if;
  if v_order.status <> 'pending' then return new; end if;
  if tg_op = 'UPDATE' then v_old_id := old.id; end if;

  select qty, max_order_qty, exposed into v_stock, v_limit, v_exposed
    from public.inventory where warehouse = v_wh and name = new.name for update;
  if v_stock is null or (not public.is_admin() and not v_exposed) then
    raise exception 'המוצר "%" אינו זמין להזמנה', new.name;
  end if;
  -- A separate query after the lock sees orders committed while we were waiting.
  select coalesce(sum(oi.qty), 0), coalesce(sum(oi.qty) filter (where o.id = new.order_id), 0)
    into v_reserved, v_order_qty
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where o.status = 'pending' and coalesce(oi.warehouse, o.warehouse) = v_wh
      and oi.name = new.name and (v_old_id is null or oi.id <> v_old_id);

  -- Existing oversubscribed orders can still be reduced while being reconciled.
  if tg_op = 'UPDATE' and old.order_id = new.order_id and old.name = new.name
     and coalesce(old.warehouse, v_order.warehouse) = v_wh and new.qty <= old.qty then
    return new;
  end if;
  if new.qty + v_reserved > v_stock then
    raise exception 'אין מספיק מלאי פנוי עבור "%". זמינות להזמנה: %', new.name, greatest(0, v_stock - v_reserved);
  end if;
  if not public.is_admin() and v_limit is not null and new.qty + v_order_qty > v_limit then
    raise exception 'הכמות עבור "%" גבוהה מהמקסימום המותר (% להזמנה)', new.name, v_limit;
  end if;
  return new;
end $$;

drop trigger if exists order_items_limit_guard on public.order_items;
create trigger order_items_limit_guard before insert or update of qty, name, order_id, warehouse
  on public.order_items for each row execute function public.enforce_order_item_limit();

-- Prevent changing the source of legacy items by editing the parent warehouse.
create or replace function public.guard_order_reservation_source()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.warehouse is distinct from old.warehouse and exists (
    select 1 from public.order_items where order_id = old.id
  ) then raise exception 'לא ניתן לשנות מחסן של הזמנה עם פריטים'; end if;
  return new;
end $$;
drop trigger if exists orders_reservation_source_guard on public.orders;
create trigger orders_reservation_source_guard before update of warehouse on public.orders
  for each row execute function public.guard_order_reservation_source();

-- Header and items either commit together or leave no empty order/reservations.
create or replace function public.submit_order(
  p_warehouse text, p_initials text, p_phone text, p_email text,
  p_cert_mode text, p_is_guest boolean, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_item record;
begin
  if auth.uid() is null then raise exception 'יש להתחבר לפני שליחת הזמנה'; end if;
  if exists(select 1 from public.profiles where id = auth.uid() and blocked_at is not null) then
    raise exception 'המשתמש חסום';
  end if;
  if nullif(btrim(p_initials), '') is null or nullif(btrim(p_phone), '') is null then
    raise exception 'יש למלא שם ומספר טלפון';
  end if;
  if p_cert_mode is null or p_cert_mode not in ('uploaded', 'at_pickup') then raise exception 'סוג תעודה אינו תקין'; end if;
  if not exists(select 1 from public.warehouses where id = p_warehouse and active) then raise exception 'המחסן אינו זמין'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'יש לבחור פריטים להזמנה'; end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'יש לבחור פריטים להזמנה'; end if;
  for v_item in select * from jsonb_to_recordset(p_items) as x(name text, qty integer) loop
    if nullif(btrim(v_item.name), '') is null or v_item.qty is null or v_item.qty < 1 then
      raise exception 'פריט או כמות אינם תקינים';
    end if;
  end loop;
  -- Every submission locks products in the same order, before writing any item.
  perform i.id from public.inventory i
    where i.warehouse = p_warehouse and i.name in (select x.name from jsonb_to_recordset(p_items) as x(name text))
    order by i.warehouse, i.name for update;
  insert into public.orders(user_id, initials, phone, email, warehouse, cert_mode, is_guest)
    values(auth.uid(), btrim(p_initials), btrim(p_phone), p_email, p_warehouse, p_cert_mode, coalesce(p_is_guest, false))
    returning id into v_id;
  insert into public.order_items(order_id, name, qty, warehouse)
    select v_id, x.name, sum(x.qty)::integer, p_warehouse
      from jsonb_to_recordset(p_items) as x(name text, qty integer)
      group by x.name order by x.name;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.approve_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_wh text; v_status text; v_rec record; v_stock integer; v_reserved bigint;
  v_results jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  select warehouse, status into v_wh, v_status from public.orders where id = p_order_id for update;
  if v_status is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_status <> 'pending' then raise exception 'ההזמנה כבר אושרה'; end if;
  perform i.id from public.inventory i where exists (
    select 1 from public.order_items oi where oi.order_id = p_order_id
      and i.warehouse = coalesce(oi.warehouse, v_wh) and i.name = oi.name
  ) order by i.warehouse, i.name for update;
  for v_rec in select name, sum(qty)::integer as qty, coalesce(warehouse, v_wh) as source_wh
    from public.order_items where order_id = p_order_id
    group by name, coalesce(warehouse, v_wh) order by coalesce(warehouse, v_wh), name
  loop
    if v_rec.qty = 0 then continue; end if;
    select qty into v_stock from public.inventory where warehouse = v_rec.source_wh and name = v_rec.name;
    if v_stock is null then raise exception 'המוצר "%" לא נמצא במלאי', v_rec.name; end if;
    select coalesce(sum(oi.qty), 0) into v_reserved
      from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.status = 'pending' and coalesce(oi.warehouse, o.warehouse) = v_rec.source_wh and oi.name = v_rec.name;
    if v_reserved > v_stock then raise exception 'אין מספיק מלאי לכל ההזמנות הממתינות עבור "%". יש להתאים כמויות לפני האישור', v_rec.name; end if;
    update public.inventory set qty = qty - v_rec.qty where warehouse = v_rec.source_wh and name = v_rec.name;
    v_results := v_results || jsonb_build_object('name', v_rec.name, 'newStock', v_stock - v_rec.qty);
  end loop;
  update public.orders set status = 'ready', approved_at = now() where id = p_order_id;
  return jsonb_build_object('ok', true, 'results', v_results);
end $$;

create or replace function public.add_order_item_admin(p_order_id uuid, p_warehouse text, p_name text, p_qty integer)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_status text; v_wh text; v_stock integer; v_reserved bigint; v_item_id bigint;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'הכמות חייבת להיות גדולה מאפס'; end if;
  select status, warehouse into v_status, v_wh from public.orders where id = p_order_id for update;
  if v_status is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_status = 'collected' then raise exception 'לא ניתן להוסיף פריט להזמנה שנאספה'; end if;
  select qty into v_stock from public.inventory where warehouse = p_warehouse and name = p_name for update;
  if v_stock is null then raise exception 'הפריט לא נמצא במלאי'; end if;
  select coalesce(sum(oi.qty), 0) into v_reserved from public.order_items oi join public.orders o on o.id = oi.order_id
    where o.status = 'pending' and coalesce(oi.warehouse, o.warehouse) = p_warehouse and oi.name = p_name;
  if p_qty > v_stock - v_reserved then raise exception 'אין מספיק מלאי פנוי עבור "%"', p_name; end if;
  select id into v_item_id from public.order_items
    where order_id = p_order_id and name = p_name and coalesce(warehouse, v_wh) = p_warehouse limit 1 for update;
  if v_item_id is null then
    insert into public.order_items(order_id, name, qty, warehouse) values(p_order_id, p_name, p_qty, p_warehouse);
  else update public.order_items set qty = qty + p_qty, warehouse = p_warehouse where id = v_item_id; end if;
  if v_status = 'ready' then update public.inventory set qty = qty - p_qty where warehouse = p_warehouse and name = p_name; end if;
  return jsonb_build_object('ok', true, 'stockUpdated', v_status = 'ready');
end $$;

create or replace function public.set_order_item_qty_admin(p_item_id bigint, p_qty integer)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_order_id uuid; v_old_qty integer; v_name text; v_wh text; v_status text;
  v_delta integer; v_stock integer; v_reserved bigint;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'הכמות אינה תקינה'; end if;
  select order_id into v_order_id from public.order_items where id = p_item_id;
  perform id from public.orders where id = v_order_id for update;
  select oi.qty, oi.name, coalesce(oi.warehouse, o.warehouse), o.status into v_old_qty, v_name, v_wh, v_status
    from public.order_items oi join public.orders o on o.id = oi.order_id where oi.id = p_item_id for update of oi;
  if v_old_qty is null then raise exception 'הפריט לא נמצא'; end if;
  if v_status = 'collected' then raise exception 'לא ניתן לערוך הזמנה שנאספה'; end if;
  v_delta := p_qty - v_old_qty;
  if v_status = 'ready' and v_delta <> 0 then
    select qty into v_stock from public.inventory where warehouse = v_wh and name = v_name for update;
    if v_stock is null then raise exception 'הפריט לא נמצא במלאי'; end if;
    select coalesce(sum(oi.qty), 0) into v_reserved from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.status = 'pending' and coalesce(oi.warehouse, o.warehouse) = v_wh and oi.name = v_name;
    if v_delta > 0 and v_delta > v_stock - v_reserved then raise exception 'אין מספיק מלאי פנוי עבור "%"', v_name; end if;
    update public.inventory set qty = qty - v_delta where warehouse = v_wh and name = v_name;
  end if;
  update public.order_items set qty = p_qty where id = p_item_id;
  return jsonb_build_object('ok', true, 'stockUpdated', v_status = 'ready');
end $$;

-- Keep active reservations and approval reversals linked when an item is renamed.
create or replace function public.rename_inventory_item(p_id bigint, p_name text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_wh text; v_old text; v_new text := btrim(p_name); v_orders integer;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  if v_new is null or v_new = '' then raise exception 'שם המוצר לא יכול להיות ריק'; end if;
  if length(v_new) > 120 then raise exception 'שם המוצר ארוך מדי (מקסימום 120 תווים)'; end if;
  select warehouse, name into v_wh, v_old from public.inventory where id = p_id for update;
  if v_wh is null then raise exception 'הפריט לא נמצא'; end if;
  if v_old = v_new then return jsonb_build_object('ok', true, 'changed', false, 'name', v_new); end if;
  if exists(select 1 from public.inventory where warehouse = v_wh and name = v_new and id <> p_id) then
    raise exception 'כבר קיים מוצר בשם "%" במחסן הזה', v_new;
  end if;
  update public.inventory set name = v_new where id = p_id;
  update public.order_items oi set name = v_new from public.orders o
    where oi.order_id = o.id and o.status in ('pending', 'ready')
      and coalesce(oi.warehouse, o.warehouse) = v_wh and oi.name = v_old;
  get diagnostics v_orders = row_count;
  return jsonb_build_object('ok', true, 'changed', true, 'old', v_old, 'name', v_new, 'pending_items_updated', v_orders);
end $$;

revoke all on function public.get_available_inventory(text) from public, anon;
revoke all on function public.submit_order(text, text, text, text, text, boolean, jsonb) from public, anon;
grant execute on function public.get_available_inventory(text) to authenticated;
grant execute on function public.submit_order(text, text, text, text, text, boolean, jsonb) to authenticated;
