-- Approvals, review copies, cut-request carry-over, events, storage accounting.

-- ---------------------------------------------------------------- review copies (H.264 fallback for H.265)
create type public.review_status as enum ('not_needed', 'pending', 'ready', 'failed');
alter table public.versions
  add column review_status public.review_status not null default 'not_needed',
  add column review_key text,
  add column review_bytes bigint,
  add column review_upload_id text;

-- ---------------------------------------------------------------- cut-request carry-over
alter table public.comments add column done_in_version_id uuid references public.versions(id) on delete set null;

-- ---------------------------------------------------------------- approvals
create type public.approval_decision as enum ('approved', 'changes_requested');
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.versions(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null default '',
  author_role public.author_role not null default 'guest',
  decision public.approval_decision not null,
  note text not null default '' check (length(note) <= 2000),
  created_at timestamptz not null default now()
);
create index approvals_version on public.approvals (version_id, created_at desc);
alter table public.approvals enable row level security;

alter table public.share_links add column allow_approval boolean not null default true;

create policy approvals_read on public.approvals for select
  using (public.can_view_asset(public.version_asset(version_id)));
create policy approvals_insert on public.approvals for insert
  with check (
    user_id = auth.uid() and (
      public.is_asset_owner(public.version_asset(version_id))
      or exists (
        select 1 from public.share_link_grants g join public.share_links l on l.id = g.share_link_id
        where l.asset_id = public.version_asset(version_id) and g.user_id = auth.uid()
          and l.revoked_at is null and (l.expires_at is null or l.expires_at > now()) and l.allow_approval
      )
    )
  );

create or replace function public.approvals_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_asset uuid; v_name text;
begin
  select asset_id into v_asset from public.versions where id = new.version_id;
  if v_asset is null then raise exception 'version not found'; end if;
  new.user_id := auth.uid();
  if public.is_asset_owner(v_asset) then
    new.author_role := 'editor';
    select display_name into v_name from public.profiles where id = auth.uid();
    new.author_name := coalesce(v_name, 'Editor');
  else
    new.author_role := 'guest';
    select display_name into v_name from public.active_grant(v_asset);
    new.author_name := coalesce(v_name, 'Guest');
  end if;
  new.created_at := now();
  return new;
end;
$$;
create trigger approvals_before_insert before insert on public.approvals
  for each row execute function public.approvals_before_insert();
revoke execute on function public.approvals_before_insert() from public, anon, authenticated;

-- my_asset_access now reports approval rights too (active_grant stays as-is: policies depend on it)
create or replace function public.grant_allows_approval(p_asset uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select l.allow_approval
    from public.share_link_grants g join public.share_links l on l.id = g.share_link_id
    where l.asset_id = p_asset and g.user_id = auth.uid()
      and l.revoked_at is null and (l.expires_at is null or l.expires_at > now())
    order by g.created_at desc limit 1), false);
$$;
drop function public.my_asset_access(uuid);
create function public.my_asset_access(p_asset uuid)
returns table (role text, display_name text, allow_comments boolean, allow_download boolean, allow_approval boolean)
language sql stable security definer set search_path = '' as $$
  select 'editor', coalesce((select display_name from public.profiles where id = auth.uid()), 'Editor'), true, true, true
  where public.is_asset_owner(p_asset)
  union all
  select 'guest', g.display_name, g.allow_comments, g.allow_download, public.grant_allows_approval(p_asset)
  from public.active_grant(p_asset) g
  where not public.is_asset_owner(p_asset)
  limit 1;
$$;
revoke execute on function public.grant_allows_approval(uuid) from public, anon;
revoke execute on function public.my_asset_access(uuid) from public, anon;
grant execute on function public.grant_allows_approval(uuid) to authenticated;
grant execute on function public.my_asset_access(uuid) to authenticated;

-- ---------------------------------------------------------------- events (metrics: playback failures, upload failures)
create table public.events (
  id bigint generated always as identity primary key,
  kind text not null check (length(kind) <= 60),
  version_id uuid references public.versions(id) on delete set null,
  user_id uuid default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
alter table public.events enable row level security;
create policy events_insert on public.events for insert with check (user_id = auth.uid());
create policy events_owner_read on public.events for select
  using (version_id is not null and public.is_asset_owner(public.version_asset(version_id)));

-- ---------------------------------------------------------------- storage accounting
create or replace function public.my_storage_bytes() returns bigint
language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(coalesce(v.original_bytes, 0) + coalesce(v.review_bytes, 0)), 0)::bigint
  from public.versions v
  join public.assets a on a.id = v.asset_id
  join public.projects p on p.id = a.project_id
  where p.owner_id = auth.uid() and v.deleted_at is null and a.deleted_at is null and p.deleted_at is null
    and v.status <> 'failed';
$$;
revoke execute on function public.my_storage_bytes() from public, anon;
grant execute on function public.my_storage_bytes() to authenticated;

-- ---------------------------------------------------------------- resolve earlier cut requests when a new version lands
create or replace function public.resolve_cut_requests(p_version uuid, p_done uuid[], p_rejected uuid[], p_reply text default null)
returns void
language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_asset_owner(public.version_asset(p_version)) then raise exception 'only the editor can do this'; end if;
  foreach v_id in array coalesce(p_done, '{}') loop
    update public.comments set status = 'done', done_in_version_id = p_version
    where id = v_id and kind = 'cut' and status in ('open', 'accepted')
      and public.version_asset(version_id) = public.version_asset(p_version);
  end loop;
  foreach v_id in array coalesce(p_rejected, '{}') loop
    perform public.set_comment_status(v_id, 'rejected', coalesce(nullif(trim(p_reply), ''), 'Not changed in the new version'));
  end loop;
end;
$$;
revoke execute on function public.resolve_cut_requests(uuid, uuid[], uuid[], text) from public, anon;
grant execute on function public.resolve_cut_requests(uuid, uuid[], uuid[], text) to authenticated;

-- done_in_version_id may only be set by the editor (the trigger otherwise copies the old value)
create or replace function public.comments_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner boolean := public.is_asset_owner(public.version_asset(old.version_id));
  v_author boolean := old.author_id = auth.uid();
  v_frames int;
begin
  new.id := old.id; new.version_id := old.version_id; new.parent_id := old.parent_id;
  new.kind := old.kind; new.author_id := old.author_id; new.author_name := old.author_name;
  new.author_role := old.author_role; new.created_at := old.created_at;
  if not v_owner then new.done_in_version_id := old.done_in_version_id; end if;

  if new.body is distinct from old.body or new.start_frame is distinct from old.start_frame
     or new.end_frame is distinct from old.end_frame then
    if not v_author then raise exception 'only the author can edit this'; end if;
    if old.kind = 'cut' and old.status <> 'open' then
      raise exception 'this cut request has been resolved and can no longer be edited';
    end if;
    select frame_count into v_frames from public.versions where id = old.version_id;
    if new.end_frame is not null and new.end_frame > v_frames then raise exception 'end frame is past the end of the video'; end if;
    if old.kind = 'cut' and (new.end_frame - new.start_frame) >= v_frames then
      raise exception 'a cut request cannot remove the whole video';
    end if;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'withdrawn' then
      if not (v_author and old.kind = 'cut' and old.status = 'open') then
        raise exception 'only the author can withdraw an open cut request';
      end if;
    elsif not v_owner then
      raise exception 'only the editor can change status';
    end if;
    new.status_by := auth.uid();
    new.status_at := now();
  else
    new.status_by := old.status_by; new.status_at := old.status_at;
  end if;

  if new.deleted_at is distinct from old.deleted_at and not (v_owner or v_author) then
    raise exception 'not allowed';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- deleting things
-- Deleting an asset or version removes its rows; the app deletes storage objects first.
-- Projects soft-delete (deleted_at) so a mistaken click is recoverable from the database.

alter publication supabase_realtime add table public.approvals;
