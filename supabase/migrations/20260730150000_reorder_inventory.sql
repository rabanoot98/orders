-- ============================================================
-- מיגרציה 06 — סידור מחדש של המלאי בפעולה אחת
--
-- move_inventory_item מחליף עם השכן — טוב לצעד בודד, מתיש
-- להעברה ארוכה. כאן מקבלים את כל סדר המחסן ומחילים אותו בבת אחת,
-- כך שגרירה או "העבר לראש" הן קריאה אחת אטומית.
-- ============================================================

create or replace function public.reorder_inventory(p_warehouse text, p_ids bigint[])
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_expected integer;
  v_given    integer := coalesce(array_length(p_ids, 1), 0);
  v_updated  integer;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה — פעולה זו מותרת למנהל בלבד';
  end if;

  if v_given = 0 then
    raise exception 'לא התקבלה רשימת פריטים';
  end if;

  -- הרשימה חייבת לכסות את כל המחסן, אחרת סידור חלקי היה
  -- דוחף פריטים שלא נשלחו אל ראש הרשימה בלי כוונה
  select count(*) into v_expected
    from public.inventory where warehouse = p_warehouse;

  if v_given <> v_expected then
    raise exception 'הרשימה חלקית (% מתוך %) — יש לשלוח את כל פריטי המחסן',
      v_given, v_expected;
  end if;

  with ordered as (
    select id, ordinality * 10 as new_sort
      from unnest(p_ids) with ordinality as t(id, ordinality)
  )
  update public.inventory i
     set sort_order = o.new_sort
    from ordered o
   where i.id = o.id
     and i.warehouse = p_warehouse;

  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception 'חלק מהפריטים אינם שייכים למחסן "%"', p_warehouse;
  end if;

  return jsonb_build_object('ok', true, 'updated', v_updated);
end $$;

grant execute on function public.reorder_inventory(text, bigint[]) to authenticated;
