-- ============================================================
-- מיגרציה 03 — סדר תצוגה של מוצרים (המנהל קובע)
-- הרץ ב-Supabase → SQL Editor
-- ============================================================

alter table public.inventory
  add column if not exists sort_order integer not null default 0;

-- מילוי ראשוני: לפי סדר האלף-בית הקיים, במרווחים של 10
with ranked as (
  select id, row_number() over (partition by warehouse order by name) * 10 as rn
  from public.inventory
)
update public.inventory i
   set sort_order = r.rn
  from ranked r
 where i.id = r.id
   and i.sort_order = 0;

create index if not exists inventory_sort_idx
  on public.inventory (warehouse, sort_order);

-- ============================================================
-- הזזת פריט למעלה/למטה (החלפה עם השכן) — אטומי
-- ============================================================
create or replace function public.move_inventory_item(p_id bigint, p_dir text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_wh    text;
  v_sort  integer;
  v_nid   bigint;
  v_nsort integer;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה — פעולה זו מותרת למנהל בלבד';
  end if;

  select warehouse, sort_order into v_wh, v_sort
    from public.inventory where id = p_id;
  if v_wh is null then
    raise exception 'הפריט לא נמצא';
  end if;

  if p_dir = 'up' then
    select id, sort_order into v_nid, v_nsort
      from public.inventory
     where warehouse = v_wh and (sort_order, id) < (v_sort, p_id)
     order by sort_order desc, id desc
     limit 1;
  else
    select id, sort_order into v_nid, v_nsort
      from public.inventory
     where warehouse = v_wh and (sort_order, id) > (v_sort, p_id)
     order by sort_order asc, id asc
     limit 1;
  end if;

  -- כבר בקצה הרשימה
  if v_nid is null then
    return jsonb_build_object('ok', true, 'moved', false);
  end if;

  -- אם הערכים זהים אין מה להחליף — נותנים לשכן ערך ביניים
  if v_nsort = v_sort then
    v_nsort := v_sort + (case when p_dir = 'up' then -1 else 1 end);
  end if;

  update public.inventory set sort_order = v_nsort where id = p_id;
  update public.inventory set sort_order = v_sort  where id = v_nid;

  return jsonb_build_object('ok', true, 'moved', true);
end $$;

grant execute on function public.move_inventory_item(bigint, text) to authenticated;

-- ============================================================
-- קליטת סחורה — פריט חדש נכנס לסוף הרשימה
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
  v_next     integer;
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
    select coalesce(max(sort_order), 0) + 10 into v_next
      from public.inventory where warehouse = p_warehouse;

    insert into public.inventory (warehouse, name, qty, category, exposed, sort_order)
    values (p_warehouse, v_name, p_qty, coalesce(nullif(p_category,''),'כללי'), p_exposed, v_next)
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
