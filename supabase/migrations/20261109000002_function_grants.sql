-- Postgres grants EXECUTE to PUBLIC by default. Lock functions down explicitly.

-- Trigger functions: nobody calls these directly.
revoke execute on function public.comments_before_insert() from public, anon, authenticated;
revoke execute on function public.comments_before_update() from public, anon, authenticated;
revoke execute on function public.versions_before_insert() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- RLS helpers and RPCs: signed-in users only (guests sign in anonymously first).
-- They only reveal what the caller can already see about themselves.
revoke execute on function public.is_asset_owner(uuid) from public, anon;
revoke execute on function public.active_grant(uuid) from public, anon;
revoke execute on function public.can_view_asset(uuid) from public, anon;
revoke execute on function public.version_asset(uuid) from public, anon;
revoke execute on function public.create_share_link(uuid, text) from public, anon;
revoke execute on function public.redeem_share_link(text, text, text) from public, anon;
revoke execute on function public.my_asset_access(uuid) from public, anon;
revoke execute on function public.set_comment_status(uuid, public.comment_status, text) from public, anon;
revoke execute on function public.share_link_info(text) from public, anon;

grant execute on function public.is_asset_owner(uuid) to authenticated;
grant execute on function public.active_grant(uuid) to authenticated;
grant execute on function public.can_view_asset(uuid) to authenticated;
grant execute on function public.version_asset(uuid) to authenticated;
grant execute on function public.create_share_link(uuid, text) to authenticated;
grant execute on function public.redeem_share_link(text, text, text) to authenticated;
grant execute on function public.my_asset_access(uuid) to authenticated;
grant execute on function public.set_comment_status(uuid, public.comment_status, text) to authenticated;
grant execute on function public.share_link_info(text) to authenticated;
