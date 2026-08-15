-- =============================================================================
-- Provision the restricted application role.
-- =============================================================================
-- ⚠️  THE POINT OF THIS FILE
-- PostgreSQL exempts SUPERUSERS from row-level security entirely, and exempts
-- TABLE OWNERS unless FORCE is set. If Growth OS connects as either, our third
-- and last layer of tenant isolation does not exist — and everything still
-- appears to work perfectly.
--
-- So: migrations run as the OWNER, and the application connects as the
-- RESTRICTED role created here.
--
-- @see docs/security/tenant-isolation.md
-- =============================================================================

CREATE DATABASE growth_os_test;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'growth_os_app') THEN
    -- NOSUPERUSER / NOCREATEDB / NOCREATEROLE are stated explicitly rather
    -- than relied on as defaults, because this is the security property.
    CREATE ROLE growth_os_app
      LOGIN PASSWORD 'local_development_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE growth_os TO growth_os_app;
GRANT USAGE ON SCHEMA public TO growth_os_app;

-- Data access only. Notably NOT: CREATE, TRUNCATE, or ownership of anything.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO growth_os_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO growth_os_app;

-- Tables created by FUTURE migrations must get the same grants automatically,
-- or every new table silently becomes unreadable by the application.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO growth_os_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO growth_os_app;
