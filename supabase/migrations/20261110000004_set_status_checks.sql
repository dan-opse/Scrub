-- Refuse status changes explicitly instead of silently updating zero rows.
create or replace function public.set_comment_status(p_comment uuid, p_status public.comment_status, p_reply text default null)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_c public.comments;
  v_rows int;
begin
  select * into v_c from public.comments where id = p_comment;
  if v_c.id is null then raise exception 'comment not found'; end if;
  if p_status = 'withdrawn' then
    if v_c.author_id <> auth.uid() then raise exception 'only the author can withdraw this'; end if;
  elsif not public.is_asset_owner(public.version_asset(v_c.version_id)) then
    raise exception 'only the editor can change status';
  end if;
  if p_status = 'rejected' and length(trim(coalesce(p_reply, ''))) = 0 then
    raise exception 'a rejection needs a reply explaining why';
  end if;
  update public.comments set status = p_status where id = p_comment;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'not allowed'; end if;
  if length(trim(coalesce(p_reply, ''))) > 0 then
    insert into public.comments (version_id, parent_id, kind, body)
    values (v_c.version_id, p_comment, 'note', trim(p_reply));
  end if;
end;
$$;
