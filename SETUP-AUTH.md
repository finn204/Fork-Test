# Locking the dashboard down

Until this is done, **anyone with the dashboard URL can read and write everything** —
food, finance, business, health. The anon key is embedded in the page source, which is
unavoidable in a browser app, so the only real protection is requiring a login.

Do these in order.

---

## 1. Create your account

Open the dashboard. You'll get a sign-in screen.

Tap **First time? Create your account**, put in your email and a password, tap
**Create account**.

If it says *"Account made. Check your email to confirm it"*, go click the link in that
email, then come back and sign in.

Don't want the email step? In Supabase go to **Authentication → Sign In / Providers →
Email** and turn **Confirm email** off, then create the account again.

There is no password reset wired up. Pick something you'll remember, or save it in your
password manager.

---

## 2. Run this SQL

Supabase → **SQL Editor** → **New query** → paste → **Run**.

Safe to run more than once.

```sql
-- app_state: signed-in users only
drop policy if exists "anon full access app_state" on public.app_state;
drop policy if exists "authenticated full access app_state" on public.app_state;

create policy "authenticated full access app_state"
  on public.app_state for all
  to authenticated using (true) with check (true);

-- progress photos: private bucket, signed-in users only
update storage.buckets set public = false where id = 'progress-photos';

drop policy if exists "anon manage progress-photos" on storage.objects;
drop policy if exists "auth manage progress-photos" on storage.objects;

create policy "auth manage progress-photos"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

You should get **Success. No rows returned.**

---

## 3. Check it worked

- Open the dashboard on your phone. Sign in. Your data should load as normal.
- Take a progress photo on the Fitness page. It should appear on your laptop too.
- Open the dashboard in a private/incognito window. You should get the sign-in screen
  and no data.

If something breaks, step 2 is reversible — swap `to authenticated` back to `to anon`
and everything returns to how it was.

---

## How photos stay private

The bucket is private, so there are no public URLs. Only the file **path** is stored and
synced. When a page needs to show a photo it mints a **signed URL** that lasts a week,
using your logged-in session. Without the login, the paths are useless.
