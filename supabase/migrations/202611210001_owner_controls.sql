-- Student Hub: owner controls and role-change audit trail
-- Apply this migration in Supabase SQL Editor before using the Owner Controls card.

create table if not exists public.owner_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  target_id uuid references auth.users(id) on delete set null,
  target_email text,
  details text,
  created_at timestamptz not null default now()
);

create index if not exists owner_audit_log_created_at_idx
  on public.owner_audit_log (created_at desc);

alter table public.owner_audit_log enable row level security;

drop policy if exists "Owners can read owner audit log" on public.owner_audit_log;
create policy "Owners can read owner audit log"
  on public.owner_audit_log
  for select
  to authenticated
  using (public.has_role(array['owner']::text[]));

revoke all on public.owner_audit_log from anon, authenticated;
grant select on public.owner_audit_log to authenticated;

create or replace function public.audit_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_id uuid;
  v_old_role text;
  v_new_role text;
  v_actor_email text;
  v_target_email text;
  v_action text;
begin
  if tg_op = 'DELETE' then
    v_target_id := old.user_id;
    v_old_role := old.role::text;
    v_new_role := null;
  elsif tg_op = 'INSERT' then
    v_target_id := new.user_id;
    v_old_role := null;
    v_new_role := new.role::text;
  else
    v_target_id := new.user_id;
    v_old_role := old.role::text;
    v_new_role := new.role::text;
  end if;

  if v_old_role is not distinct from v_new_role then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select email into v_actor_email
  from auth.users
  where id = auth.uid();

  select email into v_target_email
  from auth.users
  where id = v_target_id;

  v_action := case
    when v_new_role = 'owner' then 'Owner role granted'
    when v_old_role = 'owner' then 'Owner role removed'
    when v_new_role is null then 'Staff role removed'
    else 'Staff role changed'
  end;

  insert into public.owner_audit_log
    (actor_id, actor_email, action, target_id, target_email, details)
  values
    (auth.uid(), v_actor_email, v_action, v_target_id, v_target_email,
     coalesce(v_old_role, 'none') || ' → ' || coalesce(v_new_role, 'none'));

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists audit_user_role_changes on public.user_roles;
create trigger audit_user_role_changes
  after insert or update of role or delete on public.user_roles
  for each row execute function public.audit_user_role_change();

create or replace function public.owner_transfer_ownership(_new_owner_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_owner uuid := auth.uid();
  v_new_owner uuid;
  v_email text := lower(trim(_new_owner_email));
begin
  if v_current_owner is null
     or not public.has_role(array['owner']::text[]) then
    raise exception 'Only the current Owner can transfer ownership';
  end if;

  if v_email is null or v_email = '' then
    raise exception 'Enter the email address of an existing Student Hub account';
  end if;

  select id into v_new_owner
  from auth.users
  where lower(email) = v_email
  limit 1;

  if v_new_owner is null then
    raise exception 'No Student Hub account was found with that email';
  end if;

  if v_new_owner = v_current_owner then
    raise exception 'You are already the Owner of this account';
  end if;

  -- The existing Owner becomes Admin; the selected account becomes Owner.
  update public.user_roles
  set role = 'admin'
  where user_id = v_current_owner;

  insert into public.user_roles (user_id, role)
  values (v_new_owner, 'owner')
  on conflict (user_id)
  do update set role = 'owner';

  insert into public.owner_audit_log
    (actor_id, actor_email, action, target_id, target_email, details)
  select v_current_owner, actor.email, 'Ownership transferred',
         v_new_owner, target.email,
         'Previous Owner retained Admin access'
  from auth.users actor
  join auth.users target on target.id = v_new_owner
  where actor.id = v_current_owner;
end;
$$;

revoke all on function public.owner_transfer_ownership(text) from public, anon;
grant execute on function public.owner_transfer_ownership(text) to authenticated;
