-- The review copy's first frame timestamp can differ from the original's; the player needs both.
alter table public.versions add column review_first_pts double precision not null default 0;
