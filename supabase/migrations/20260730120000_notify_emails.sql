-- ============================================================
-- מיגרציה 02 — כתובות מייל להתראה על הזמנה חדשה
-- הרץ ב-Supabase → SQL Editor (אחרי schema.sql)
-- ============================================================

create table if not exists public.notify_emails (
  id         bigint generated always as identity primary key,
  email      text not null,
  label      text,                                   -- תיאור חופשי, למשל "קצין דת"
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- מונע כפילויות ללא תלות באותיות גדולות/קטנות
create unique index if not exists notify_emails_email_uniq
  on public.notify_emails (lower(email));

alter table public.notify_emails enable row level security;

-- רק המנהל רואה ומנהל את הרשימה
drop policy if exists "notify_admin_all" on public.notify_emails;
create policy "notify_admin_all" on public.notify_emails
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- הכתובות שהיו בגיליון "הגדרות"
insert into public.notify_emails (email, label) values
  ('rabanoot98@gmail.com', 'מנהל'),
  ('micael.grr@gmail.com', 'מייל נוסף')
on conflict do nothing;
