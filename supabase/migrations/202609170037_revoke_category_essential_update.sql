-- Integration reconciliation: 0034 (L16 analytics) granted UPDATE (essential)
-- on public.categories, but the contract exposes only category list and
-- create, and analytics only reads the flag. Keep the INSERT grant from 0031
-- and remove the unused column UPDATE privilege.
revoke update (essential) on public.categories from savia_application;
