alter table public.order_items add column if not exists warehouse text;

create or replace function public.approve_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_wh text; v_status text; v_rec record; v_new integer;
  v_results jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'אין הרשאה — פעולה זו מותרת למנהל בלבד'; end if;
  select warehouse, status into v_wh, v_status from public.orders where id = p_order_id for update;
  if v_wh is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_status <> 'pending' then raise exception 'ההזמנה כבר אושרה'; end if;

  for v_rec in select name, qty, coalesce(warehouse, v_wh) as source_wh from public.order_items where order_id = p_order_id loop
    v_new := null;
    update public.inventory set qty = greatest(0, qty - v_rec.qty)
      where warehouse = v_rec.source_wh and name = v_rec.name returning qty into v_new;
    if v_new is null then
      v_results := v_results || jsonb_build_object('name', v_rec.name, 'notFound', true);
    else
      v_results := v_results || jsonb_build_object('name', v_rec.name, 'newStock', v_new);
    end if;
  end loop;
  update public.orders set status = 'ready', approved_at = now() where id = p_order_id;
  return jsonb_build_object('ok', true, 'results', v_results);
end $$;

create or replace function public.add_order_item_admin(
  p_order_id uuid, p_warehouse text, p_name text, p_qty integer
) returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text; v_stock integer; v_item_id bigint;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  if p_qty < 1 then raise exception 'הכמות חייבת להיות גדולה מאפס'; end if;
  select status into v_status from public.orders where id = p_order_id for update;
  if v_status is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_status = 'collected' then raise exception 'לא ניתן להוסיף פריט להזמנה שנאספה'; end if;

  select qty into v_stock from public.inventory
    where warehouse = p_warehouse and name = p_name for update;
  if v_stock is null then raise exception 'הפריט לא נמצא במלאי'; end if;
  if v_status = 'ready' and v_stock < p_qty then raise exception 'אין מספיק יחידות במלאי'; end if;

  select id into v_item_id from public.order_items
    where order_id = p_order_id and name = p_name
      and coalesce(warehouse, (select warehouse from public.orders where id = p_order_id)) = p_warehouse
    limit 1 for update;
  if v_item_id is null then
    insert into public.order_items(order_id, name, qty, warehouse)
      values (p_order_id, p_name, p_qty, p_warehouse);
  else
    update public.order_items set qty = qty + p_qty, warehouse = p_warehouse where id = v_item_id;
  end if;

  if v_status = 'ready' then
    update public.inventory set qty = qty - p_qty
      where warehouse = p_warehouse and name = p_name;
  end if;
  return jsonb_build_object('ok', true, 'stockUpdated', v_status = 'ready');
end $$;

create or replace function public.cancel_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text; v_wh text; v_rec record;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  select status, warehouse into v_status, v_wh from public.orders where id = p_order_id for update;
  if v_status is null then raise exception 'ההזמנה לא נמצאה'; end if;

  if v_status = 'ready' then
    for v_rec in select name, qty, coalesce(warehouse, v_wh) as source_wh
      from public.order_items where order_id = p_order_id loop
      update public.inventory set qty = qty + v_rec.qty
        where warehouse = v_rec.source_wh and name = v_rec.name;
    end loop;
  end if;
  delete from public.orders where id = p_order_id;
  return jsonb_build_object('ok', true, 'stockReturned', v_status = 'ready');
end $$;

create or replace function public.set_order_item_qty_admin(p_item_id bigint, p_qty integer)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_old_qty integer; v_name text; v_item_wh text; v_order_wh text;
  v_status text; v_delta integer; v_stock integer;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  if p_qty < 0 then raise exception 'הכמות אינה תקינה'; end if;

  select oi.qty, oi.name, oi.warehouse, o.warehouse, o.status
    into v_old_qty, v_name, v_item_wh, v_order_wh, v_status
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where oi.id = p_item_id for update of oi, o;
  if v_old_qty is null then raise exception 'הפריט לא נמצא'; end if;
  if v_status = 'collected' then raise exception 'לא ניתן לערוך הזמנה שנאספה'; end if;

  v_item_wh := coalesce(v_item_wh, v_order_wh);
  v_delta := p_qty - v_old_qty;
  if v_status = 'ready' and v_delta <> 0 then
    select qty into v_stock from public.inventory
      where warehouse = v_item_wh and name = v_name for update;
    if v_stock is null then raise exception 'הפריט לא נמצא במלאי'; end if;
    if v_delta > 0 and v_stock < v_delta then raise exception 'אין מספיק יחידות במלאי'; end if;
    update public.inventory set qty = qty - v_delta
      where warehouse = v_item_wh and name = v_name;
  end if;

  update public.order_items set qty = p_qty where id = p_item_id;
  return jsonb_build_object('ok', true, 'stockUpdated', v_status = 'ready');
end $$;

grant execute on function public.add_order_item_admin(uuid, text, text, integer) to authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;
grant execute on function public.set_order_item_qty_admin(bigint, integer) to authenticated;
