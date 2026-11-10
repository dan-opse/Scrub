-- Guests can't read share_links directly, so the insert policy must go through the security-definer helper.
drop policy approvals_insert on public.approvals;
create policy approvals_insert on public.approvals for insert
  with check (
    user_id = auth.uid() and (
      public.is_asset_owner(public.version_asset(version_id))
      or public.grant_allows_approval(public.version_asset(version_id))
    )
  );
