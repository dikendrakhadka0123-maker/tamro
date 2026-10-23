-- TAMRO — optional Supabase setup for (1) server-sent meal reminders and (2) shared dish ratings.
-- Run in Supabase → SQL Editor. NOT TESTED against your project: read it, then run each block once.
-- The app works without this file (reminders then only show while the app is open; ratings stay on each phone).

-- ─────────────────────────────────────────────────────────────
-- 1) MEAL REMINDERS  (customer taps Breakfast / Lunch / Dinner in the app)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.customer_meal_prefs (
  phone      text primary key,
  breakfast  boolean not null default false,
  lunch      boolean not null default false,
  dinner     boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.customer_meal_prefs enable row level security;
drop policy if exists meal_prefs_all on public.customer_meal_prefs;
create policy meal_prefs_all on public.customer_meal_prefs for all using (true) with check (true);

-- Sends one push per opted-in customer by calling your EXISTING "send-order-push" function.
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.send_meal_reminder(meal text) returns void
language plpgsql security definer as $$
declare
  r record; ttl text; bdy text;
begin
  if meal = 'breakfast' then ttl := '🍳 Breakfast time!';  bdy := 'Order something hot from TAMRO.  बिहानको खाजा अर्डर गर्नुहोस्।';
  elsif meal = 'lunch' then ttl := '🍛 Lunch time!';        bdy := 'Hungry? Order from TAMRO.  खाना अर्डर गर्नुहोस्।';
  else                      ttl := '🍽 Dinner time!';       bdy := 'Order tonight''s meal from TAMRO.  बेलुकाको खाना अर्डर गर्नुहोस्।';
  end if;
  for r in
    select phone from public.customer_meal_prefs
    where (meal='breakfast' and breakfast) or (meal='lunch' and lunch) or (meal='dinner' and dinner)
  loop
    perform net.http_post(
      url     := 'https://eqvdtomtgxwgdtnniuzv.supabase.co/functions/v1/send-order-push',
      headers := jsonb_build_object('Content-Type','application/json',
                                    'apikey','<YOUR_ANON_KEY>',
                                    'Authorization','Bearer <YOUR_ANON_KEY>'),
      body    := jsonb_build_object('phone', r.phone, 'title', ttl, 'body', bdy, 'url', './?customer=1')
    );
  end loop;
end $$;

-- Nepal time is UTC+5:45, so 08:00 NPT = 02:15 UTC, 12:30 NPT = 06:45 UTC, 19:00 NPT = 13:15 UTC.
select cron.unschedule(jobid) from cron.job where jobname in ('tamro-breakfast','tamro-lunch','tamro-dinner');
select cron.schedule('tamro-breakfast', '15 2 * * *',  $$select public.send_meal_reminder('breakfast')$$);
select cron.schedule('tamro-lunch',     '45 6 * * *',  $$select public.send_meal_reminder('lunch')$$);
select cron.schedule('tamro-dinner',    '15 13 * * *', $$select public.send_meal_reminder('dinner')$$);

-- ─────────────────────────────────────────────────────────────
-- 2) SHARED DISH RATINGS  (the app already sends ratings here when the tables exist)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.food_ratings (
  food_id    bigint not null,
  device     text   not null,
  stars      int    not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (food_id, device)
);
alter table public.food_ratings enable row level security;
drop policy if exists food_ratings_all on public.food_ratings;
create policy food_ratings_all on public.food_ratings for all using (true) with check (true);

create or replace view public.food_rating_summary as
  select food_id, round(avg(stars)::numeric, 1) as rating_avg, count(*) as rating_count
  from public.food_ratings group by food_id;
grant select on public.food_rating_summary to anon;
