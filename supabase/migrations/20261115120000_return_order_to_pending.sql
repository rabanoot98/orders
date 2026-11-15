-- Reverse approval in one transaction so approving again deducts stock only once.
create or replace function public.return_order_to_pending(p_order_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text; v_wh text; v_rec record;
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;

  select status, warehouse into v_status, v_wh
    from public.orders where id = p_order_id for update;
  if v_status is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_status <> 'ready' then raise exception 'ניתן להחזיר לממתינות רק הזמנה שמוכנה לאיסוף'; end if;

  for v_rec in
    select name, sum(qty) as qty, coalesce(warehouse, v_wh) as source_wh
      from public.order_items where order_id = p_order_id
      group by name, coalesce(warehouse, v_wh)
      order by coalesce(warehouse, v_wh), name
  loop
    update public.inventory set qty = qty + v_rec.qty
      where warehouse = v_rec.source_wh and name = v_rec.name;
  end loop;

  update public.orders set status = 'pending', approved_at = null where id = p_order_id;
  return jsonb_build_object('ok', true, 'stockReturned', true);
end $$;

revoke all on function public.return_order_to_pending(uuid) from public, anon;
grant execute on function public.return_order_to_pending(uuid) to authenticated;
