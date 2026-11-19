-- RouteWatch schema, version 1. Applied by `npm run db:migrate` (see migrate.js); never edit an applied
-- migration, add a new numbered file instead.
--
-- Design notes
--  * Natural, stable keys are kept (username, bus_id, route_id, stop_id) because the whole API, the audit log
--    and the React client already identify records by them.
--  * Business rules that must hold no matter which code path writes the data are CHECK / UNIQUE / FOREIGN KEY
--    constraints. The application validates the same rules first so users get clear messages.
--  * Records are never deleted by the application (buses, routes and stops are deactivated), so the foreign
--    keys are ON DELETE RESTRICT.
--  * Roles and permissions stay in code (permissions.js, default deny). Only the role NAME is stored per user
--    and constrained here, so a permission matrix change is a code review, not a runtime data edit.

CREATE TABLE users (
  username       text        PRIMARY KEY CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  password_hash  text        NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'),  -- bcrypt only, never a plaintext password
  role           text        NOT NULL CHECK (role IN ('admin', 'dispatcher', 'passenger')),
  active         boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Server-side login sessions. Only the SHA-256 hash of the browser's token is stored.
CREATE TABLE sessions (
  token_hash  char(64)    PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  username    text        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_username_idx ON sessions (username);
CREATE INDEX sessions_expires_idx  ON sessions (expires_at);

CREATE TABLE buses (
  bus_id      text        PRIMARY KEY CHECK (bus_id ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  plate       text        CHECK (plate IS NULL OR plate ~ '^[A-Z0-9][A-Z0-9 -]{2,11}$'),
  -- "ABC-1234" and "abc 1234" are the same plate
  plate_key   text        GENERATED ALWAYS AS (upper(regexp_replace(plate, '[[:space:]-]', '', 'g'))) STORED,
  capacity    integer     CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 120),  -- also the ceiling for the future passenger counter
  model       text        CHECK (model IS NULL OR char_length(model) BETWEEN 2 AND 60),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX buses_plate_key_uq ON buses (plate_key);   -- NULLs are allowed more than once

-- Which tracking device may report for which bus. Only a hash of the device token is stored.
CREATE TABLE tracking_devices (
  device_id   text        PRIMARY KEY CHECK (device_id ~ '^[a-z0-9_-]{3,32}$'),
  bus_id      text        NOT NULL REFERENCES buses (bus_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  source      text        NOT NULL CHECK (source IN ('simulation', 'gps')),
  active      boolean     NOT NULL DEFAULT true,
  token_hash  char(64)    NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tracking_devices_one_active_per_bus ON tracking_devices (bus_id) WHERE active;

CREATE TABLE stops (
  stop_id     text             PRIMARY KEY CHECK (stop_id ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  name        text             NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  address     text             CHECK (address IS NULL OR char_length(address) <= 200),
  lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  status      text             NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  timestamptz      NOT NULL DEFAULT now(),
  updated_at  timestamptz      NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stops_name_uq ON stops (lower(name));

CREATE TABLE routes (
  route_id     text        PRIMARY KEY CHECK (route_id ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description  text        CHECK (description IS NULL OR char_length(description) <= 200),
  start_point  text        NOT NULL CHECK (char_length(start_point) BETWEEN 2 AND 80),
  destination  text        NOT NULL CHECK (char_length(destination) BETWEEN 2 AND 80),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX routes_name_uq ON routes (lower(name));

-- Many-to-many, ordered. A stop appears once per route and each position is used once per route.
-- The position constraint is deferred so a reorder can renumber rows inside one transaction.
-- (Positions being gap-free 1..n is kept by network.js, which always renumbers inside the transaction.)
CREATE TABLE route_stops (
  route_id  text    NOT NULL REFERENCES routes (route_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  stop_id   text    NOT NULL REFERENCES stops (stop_id)   ON UPDATE CASCADE ON DELETE RESTRICT,
  position  integer NOT NULL CHECK (position >= 1),
  PRIMARY KEY (route_id, stop_id),
  CONSTRAINT route_stops_position_uq UNIQUE (route_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX route_stops_stop_idx ON route_stops (stop_id);

-- A bus runs ONE route at a time (bus_id is the primary key).
CREATE TABLE bus_route_assignments (
  bus_id       text        PRIMARY KEY REFERENCES buses (bus_id)   ON UPDATE CASCADE ON DELETE RESTRICT,
  route_id     text        NOT NULL    REFERENCES routes (route_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  assigned_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bus_route_assignments_route_idx ON bus_route_assignments (route_id);

-- Defence in depth for the assignment rules (the application checks them first and reports clear errors):
-- only an ACTIVE bus can be assigned, and only to an ACTIVE route.
-- FOR SHARE locks the bus and the route row until the assignment commits. Without it, an assignment and a
-- simultaneous "bus leaves service" could both succeed and leave an out-of-service bus on a route (write skew).
-- With it, one of them waits for the other and then sees its result. Lock order is always bus, then route.
CREATE FUNCTION rw_check_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bus_status text; route_status text;
BEGIN
  SELECT status INTO bus_status FROM buses WHERE bus_id = NEW.bus_id FOR SHARE;
  IF bus_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'only an active bus can be assigned to a route' USING ERRCODE = 'check_violation', CONSTRAINT = 'assignment_bus_active';
  END IF;
  SELECT status INTO route_status FROM routes WHERE route_id = NEW.route_id FOR SHARE;
  IF route_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'buses can only be assigned to an active route' USING ERRCODE = 'check_violation', CONSTRAINT = 'assignment_route_active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bus_route_assignments_check BEFORE INSERT OR UPDATE ON bus_route_assignments
  FOR EACH ROW EXECUTE FUNCTION rw_check_assignment();

-- Backstop: a bus that leaves service, or a route that is deactivated, loses its assignments.
CREATE FUNCTION rw_drop_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'buses' THEN DELETE FROM bus_route_assignments WHERE bus_id = NEW.bus_id;
  ELSE DELETE FROM bus_route_assignments WHERE route_id = NEW.route_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER buses_leave_service AFTER UPDATE OF status ON buses
  FOR EACH ROW WHEN (NEW.status <> 'active') EXECUTE FUNCTION rw_drop_assignments();
CREATE TRIGGER routes_deactivated AFTER UPDATE OF status ON routes
  FOR EACH ROW WHEN (NEW.status <> 'active') EXECUTE FUNCTION rw_drop_assignments();

-- Append-only security trail. No foreign keys on purpose: entries must outlive (and may name) anything,
-- including unknown users, devices and "system". The application account is granted INSERT and SELECT only.
CREATE TABLE audit_logs (
  id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  action  text        NOT NULL,
  actor   text,
  role    text,
  target  text,
  outcome text        NOT NULL DEFAULT 'success',
  ip      text,
  detail  jsonb
);
CREATE INDEX audit_logs_ts_idx     ON audit_logs (ts DESC, id DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor);

-- Belt and braces: even the table owner cannot edit or delete audit rows by accident.
CREATE FUNCTION rw_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION rw_audit_immutable();
