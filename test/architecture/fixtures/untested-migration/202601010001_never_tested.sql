-- Architecture fitness rule 13 fixture: this migration is never referenced in tests
create table test_never_tested (
  id uuid primary key default gen_random_uuid()
);
