-- Scrub core schema. Every table has RLS enabled.
-- Times inside a video are whole frame numbers on a specific version.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Editor',
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null check (length(name) between 1 and 200),
  default_start_tc text not null default '00:00:00:00' check (default_start_tc ~ '^\d{2}:\d{2}:\d{2}[:;]\d{2}$'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (length(name) between 1 and 300),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create type public.version_status as enum ('uploading', 'ready', 'failed');

create table public.versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  number int not null,
  status public.version_status not null default 'uploading',
  original_key text,
  original_filename text not null,
  original_bytes bigint not null check (original_bytes > 0),
  container text,
  mime_type text,
  video_codec_string text,
  is_hdr boolean not null default false,
  width int,
  height int,
  rotation int not null default 0,
  fps_num int not null check (fps_num > 0),
  fps_den int not null check (fps_den > 0),
  frame_count int not null check (frame_count > 0),
  first_pts double precision not null default 0,
  start_tc_frames int not null default 0, -- start timecode expressed as a frame count at this version's rate
  drop_frame boolean not null default false,
  is_vfr boolean not null default false,
  audio_codec text,
  upload_id text,
  uploaded_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (asset_id, number)
);

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  token text not null unique,
  label text,
  allow_comments boolean not null default true,
  allow_download boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.share_link_grants (
  share_link_id uuid not null references public.share_links(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 80),
  email text,
  created_at timestamptz not null default now(),
  primary key (share_link_id, user_id)
);

create type public.comment_kind as enum ('note', 'cut');
create type public.comment_status as enum ('open', 'accepted', 'rejected', 'done', 'withdrawn');
create type public.author_role as enum ('editor', 'guest');

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.versions(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  kind public.comment_kind not null default 'note',
  start_frame int,
  end_frame int,
  body text not null default '' check (length(body) <= 5000),
  status public.comment_status not null default 'open',
  status_by uuid references auth.users(id),
  status_at timestamptz,
  author_id uuid not null default auth.uid() references auth.users(id),
  author_name text not null default '',
  author_role public.author_role not null default 'guest',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint frames_sane check (
    (start_frame is null and end_frame is null)
    or (start_frame >= 0 and (end_frame is null or end_frame > start_frame))
  ),
  constraint cut_needs_range check (kind <> 'cut' or (start_frame is not null and end_frame is not null)),
  constraint note_statuses check (kind = 'cut' or status in ('open', 'done')),
  constraint cut_not_reply check (kind <> 'cut' or parent_id is null)
);

create index comments_version_frame on public.comments (version_id, start_frame);
create index comments_version_updated on public.comments (version_id, updated_at);
create index grants_user on public.share_link_grants (user_id);
create index versions_asset on public.versions (asset_id, number);
create index assets_project on public.assets (project_id);

-- ---------------------------------------------------------------- access helpers
-- SECURITY DEFINER so policies can call them without recursive RLS checks.

create or replace function public.is_asset_owner(p_asset uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assets a join public.projects p on p.id = a.project_id
    where a.id = p_asset and p.owner_id = auth.uid()
  );
$$;

create or replace function public.active_grant(p_asset uuid)
returns table (share_link_id uuid, display_name text, allow_comments boolean, allow_download boolean)
language sql stable security definer set search_path = '' as $$
  select g.share_link_id, g.display_name, l.allow_comments, l.allow_download
  from public.share_link_grants g join public.share_links l on l.id = g.share_link_id
  where l.asset_id = p_asset and g.user_id = auth.uid()
    and l.revoked_at is null and (l.expires_at is null or l.expires_at > now())
  order by g.created_at desc limit 1;
$$;

create or replace function public.can_view_asset(p_asset uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_asset_owner(p_asset) or exists (select 1 from public.active_grant(p_asset));
$$;

create or replace function public.version_asset(p_version uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select asset_id from public.versions where id = p_version;
$$;

-- ---------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.assets enable row level security;
alter table public.versions enable row level security;
alter table public.share_links enable row level security;
alter table public.share_link_grants enable row level security;
alter table public.comments enable row level security;

create policy profiles_self on public.profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

create policy projects_owner on public.projects for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false);

create policy assets_owner on public.assets for all
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy assets_guest_read on public.assets for select
  using (exists (select 1 from public.active_grant(id)));

create policy versions_owner on public.versions for all
  using (public.is_asset_owner(asset_id)) with check (public.is_asset_owner(asset_id));
create policy versions_guest_read on public.versions for select
  using (status = 'ready' and deleted_at is null and exists (select 1 from public.active_grant(asset_id)));

create policy share_links_owner on public.share_links for all
  using (public.is_asset_owner(asset_id)) with check (public.is_asset_owner(asset_id));

create policy grants_owner_read on public.share_link_grants for select
  using (exists (select 1 from public.share_links l where l.id = share_link_id and public.is_asset_owner(l.asset_id)));
create policy grants_self_read on public.share_link_grants for select
  using (user_id = auth.uid());

create policy comments_read on public.comments for select
  using (public.can_view_asset(public.version_asset(version_id)));
create policy comments_insert on public.comments for insert
  with check (
    author_id = auth.uid() and (
      public.is_asset_owner(public.version_asset(version_id))
      or exists (select 1 from public.active_grant(public.version_asset(version_id)) g where g.allow_comments)
    )
  );
create policy comments_update on public.comments for update
  using (
    author_id = auth.uid()
    or public.is_asset_owner(public.version_asset(version_id))
  );

-- ---------------------------------------------------------------- triggers

-- Fill author fields and validate ranges against the version on insert.
create or replace function public.comments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_asset uuid;
  v_frames int;
  v_name text;
  v_parent public.comments;
begin
  select asset_id, frame_count into v_asset, v_frames from public.versions where id = new.version_id;
  if v_asset is null then raise exception 'version not found'; end if;

  if public.is_asset_owner(v_asset) then
    new.author_role := 'editor';
    select display_name into v_name from public.profiles where id = auth.uid();
    new.author_name := coalesce(v_name, 'Editor');
  else
    new.author_role := 'guest';
    select display_name into v_name from public.active_grant(v_asset);
    new.author_name := coalesce(v_name, 'Guest');
  end if;

  new.author_id := auth.uid();
  new.status := 'open';
  new.status_by := null;
  new.status_at := null;
  new.created_at := now();
  new.updated_at := now();
  new.deleted_at := null;

  if new.parent_id is not null then
    select * into v_parent from public.comments where id = new.parent_id;
    if v_parent.id is null or v_parent.version_id <> new.version_id or v_parent.parent_id is not null then
      raise exception 'replies must point at a top-level comment on the same version';
    end if;
    new.start_frame := null;
    new.end_frame := null;
  end if;

  if new.start_frame is not null and new.start_frame >= v_frames then
    raise exception 'start frame is past the end of the video';
  end if;
  if new.end_frame is not null and new.end_frame > v_frames then
    raise exception 'end frame is past the end of the video';
  end if;
  if new.kind = 'cut' and (new.end_frame - new.start_frame) >= v_frames then
    raise exception 'a cut request cannot remove the whole video';
  end if;
  return new;
end;
$$;

create trigger comments_before_insert before insert on public.comments
  for each row execute function public.comments_before_insert();

-- Enforce who may change what on update.
create or replace function public.comments_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner boolean := public.is_asset_owner(public.version_asset(old.version_id));
  v_author boolean := old.author_id = auth.uid();
  v_frames int;
begin
  -- immutable fields
  new.id := old.id; new.version_id := old.version_id; new.parent_id := old.parent_id;
  new.kind := old.kind; new.author_id := old.author_id; new.author_name := old.author_name;
  new.author_role := old.author_role; new.created_at := old.created_at;

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

create trigger comments_before_update before update on public.comments
  for each row execute function public.comments_before_update();

-- Version numbers are assigned by the database.
create or replace function public.versions_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.asset_id::text));
  select coalesce(max(number), 0) + 1 into new.number from public.versions where asset_id = new.asset_id;
  new.status := 'uploading';
  return new;
end;
$$;
create trigger versions_before_insert before insert on public.versions
  for each row execute function public.versions_before_insert();

-- Profile row for each new non-anonymous user.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.is_anonymous, false) = false then
    insert into public.profiles (id, display_name)
    values (new.id, coalesce(nullif(split_part(new.email, '@', 1), ''), 'Editor'))
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- RPCs

-- Editor creates a share link; the token is generated in the database.
create or replace function public.create_share_link(p_asset uuid, p_label text default null)
returns public.share_links
language plpgsql security definer set search_path = '' as $$
declare
  v_link public.share_links;
  v_token text;
begin
  if not public.is_asset_owner(p_asset) then raise exception 'not allowed'; end if;
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/', '-_'), '=');
  insert into public.share_links (asset_id, token, label) values (p_asset, v_token, p_label)
  returning * into v_link;
  return v_link;
end;
$$;

-- Public info shown on the guest landing page before joining.
create or replace function public.share_link_info(p_token text)
returns table (asset_name text, project_name text, editor_name text, active boolean)
language sql stable security definer set search_path = '' as $$
  select a.name, p.name, coalesce(pr.display_name, 'your editor'),
         (l.revoked_at is null and (l.expires_at is null or l.expires_at > now()))
  from public.share_links l
  join public.assets a on a.id = l.asset_id
  join public.projects p on p.id = a.project_id
  left join public.profiles pr on pr.id = p.owner_id
  where l.token = p_token;
$$;

-- Guest joins a share link (called after anonymous sign-in).
create or replace function public.redeem_share_link(p_token text, p_display_name text, p_email text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_link public.share_links;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into v_link from public.share_links where token = p_token;
  if v_link.id is null or v_link.revoked_at is not null or (v_link.expires_at is not null and v_link.expires_at <= now()) then
    raise exception 'This link is no longer active';
  end if;
  if length(trim(coalesce(p_display_name, ''))) = 0 then raise exception 'enter a name'; end if;
  insert into public.share_link_grants (share_link_id, user_id, display_name, email)
  values (v_link.id, auth.uid(), left(trim(p_display_name), 80), nullif(trim(p_email), ''))
  on conflict (share_link_id, user_id) do update set display_name = excluded.display_name, email = excluded.email;
  return v_link.asset_id;
end;
$$;

-- What the current user may do on an asset.
create or replace function public.my_asset_access(p_asset uuid)
returns table (role text, display_name text, allow_comments boolean, allow_download boolean)
language sql stable security definer set search_path = '' as $$
  select 'editor', coalesce((select display_name from public.profiles where id = auth.uid()), 'Editor'), true, true
  where public.is_asset_owner(p_asset)
  union all
  select 'guest', g.display_name, g.allow_comments, g.allow_download
  from public.active_grant(p_asset) g
  where not public.is_asset_owner(p_asset)
  limit 1;
$$;

-- Editor sets a status; rejecting a cut request requires a reply, saved in the same transaction.
create or replace function public.set_comment_status(p_comment uuid, p_status public.comment_status, p_reply text default null)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_c public.comments;
begin
  select * into v_c from public.comments where id = p_comment;
  if v_c.id is null then raise exception 'comment not found'; end if;
  if p_status = 'rejected' and length(trim(coalesce(p_reply, ''))) = 0 then
    raise exception 'a rejection needs a reply explaining why';
  end if;
  update public.comments set status = p_status where id = p_comment;
  if length(trim(coalesce(p_reply, ''))) > 0 then
    insert into public.comments (version_id, parent_id, kind, body)
    values (v_c.version_id, p_comment, 'note', trim(p_reply));
  end if;
end;
$$;

revoke execute on function public.create_share_link(uuid, text) from anon;
revoke execute on function public.redeem_share_link(text, text, text) from anon;
revoke execute on function public.set_comment_status(uuid, public.comment_status, text) from anon;
revoke execute on function public.my_asset_access(uuid) from anon;

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.comments;
