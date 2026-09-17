begin;

-- PostgreSQL does not create indexes for foreign keys. The partial uniqueness
-- index covers active custody checks, while this full index also supports the
-- units -> loans foreign-key validation across returned historical rows.
create index loans_by_unit on warehouse.loans(unit_id);

-- These predicates are used for staff session revocation and rate-limit
-- retention on every related operation.
create index sessions_by_actor on warehouse.sessions(actor_id, actor_type);
create index rate_limits_by_window on warehouse.rate_limits(window_start);

commit;
