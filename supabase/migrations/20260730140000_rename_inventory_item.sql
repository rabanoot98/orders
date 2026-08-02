-- ============================================================
-- מיגרציה 05 — שינוי שם מוצר במלאי
--
-- order_items שומר את שם המוצר כטקסט, ו-approve_order מתאים לפיו.
-- לכן שינוי שם "מנתק" הזמנות ממתינות: באישור הפריט לא יימצא
-- והמלאי לא יירד. הפונקציה מעדכנת גם אותן, באותה טרנזקציה.
--
-- הזמנות שכבר אושרו (ready/collected) נשארות עם השם הישן —
-- הן רשומה היסטורית של מה שנמסר בפועל.
-- ============================================================

create or replace function public.rename_inventory_item(p_id bigint, p_name text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_wh       text;
  v_old      text;
  v_new      text := btrim(p_name);
  v_dupe     bigint;
  v_orders   integer := 0;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה — פעולה זו מותרת למנהל בלבד';
  end if;

  if v_new is null or v_new = '' then
    raise exception 'שם המוצר לא יכול להיות ריק';
  end if;
  if length(v_new) > 120 then
    raise exception 'שם המוצר ארוך מדי (מקסימום 120 תווים)';
  end if;

  select warehouse, name into v_wh, v_old
    from public.inventory where id = p_id for update;
  if v_wh is null then
    raise exception 'הפריט לא נמצא';
  end if;

  -- אין שינוי בפועל
  if v_old = v_new then
    return jsonb_build_object('ok', true, 'changed', false, 'name', v_new);
  end if;

  -- שם כפול באותו מחסן
  select id into v_dupe
    from public.inventory
   where warehouse = v_wh and name = v_new and id <> p_id
   limit 1;
  if v_dupe is not null then
    raise exception 'כבר קיים מוצר בשם "%" במחסן הזה', v_new;
  end if;

  update public.inventory set name = v_new where id = p_id;

  -- שמירת הקשר להזמנות שטרם אושרו
  update public.order_items oi
     set name = v_new
    from public.orders o
   where oi.order_id = o.id
     and o.status = 'pending'
     and o.warehouse = v_wh
     and oi.name = v_old;
  get diagnostics v_orders = row_count;

  return jsonb_build_object(
    'ok', true, 'changed', true,
    'old', v_old, 'name', v_new,
    'pending_items_updated', v_orders
  );
end $$;

grant execute on function public.rename_inventory_item(bigint, text) to authenticated;
