-- The client never chooses a version number; the trigger assigns it.
alter table public.versions alter column number set default 0;
