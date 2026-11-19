-- RouteWatch migration 002: conductor role and passenger occupancy.
-- Runs once (migrate.js records it in schema_migrations). It only ADDS to what migration 001 created:
-- existing users, buses, routes, stops, devices and audit records are not changed.
--
-- Design notes
--  * The passenger count is one column of "buses" (a bus has one current count), not a separate table, so a count
--    can never exist for a bus that does not exist and cannot be duplicated.
--  * NULL means "not reported": nobody is counting on that bus right now. That is different from a real 0, and the
--    screens never show a made-up number for it.
--  * Who may count which bus is one small table, conductor_assignments: one conductor counts one bus at a time and
--    a bus has one conductor at a time (both columns are unique).

-- 1. The conductor role (users.role is checked by the database, so the list has to be widened here).
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'dispatcher', 'conductor', 'passenger'));

-- 2. The passenger count. The database itself refuses a negative count or one above the capacity.
ALTER TABLE buses
  ADD COLUMN passenger_count       integer,
  ADD COLUMN occupancy_updated_at  timestamptz,
  ADD CONSTRAINT buses_passenger_count_range
    CHECK (passenger_count IS NULL OR passenger_count >= 0),
  ADD CONSTRAINT buses_occupancy_within_capacity
    CHECK (passenger_count IS NULL OR (capacity IS NOT NULL AND passenger_count <= capacity));

-- A bus that is not in service has no passengers to count: its count goes back to "not reported".
CREATE FUNCTION rw_bus_occupancy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN NEW.passenger_count := NULL; NEW.occupancy_updated_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER buses_occupancy_guard BEFORE UPDATE ON buses
  FOR EACH ROW EXECUTE FUNCTION rw_bus_occupancy_guard();

-- 3. Which conductor counts which bus.
CREATE TABLE conductor_assignments (
  conductor    text        PRIMARY KEY REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
  bus_id       text        NOT NULL UNIQUE REFERENCES buses (bus_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  assigned_at  timestamptz NOT NULL DEFAULT now()
);

-- Defence in depth (the application checks first and reports clear messages): only an ACTIVE conductor account can
-- be assigned, and only to an ACTIVE bus. FOR SHARE keeps the user and the bus row from changing until the assignment
-- commits, so "assign" and "deactivate" running at the same moment cannot both win (same technique as bus_route_assignments).
-- Lock order is always user, then bus.
CREATE FUNCTION rw_check_conductor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u_role text; u_active boolean; b_status text;
BEGIN
  SELECT role, active INTO u_role, u_active FROM users WHERE username = NEW.conductor FOR SHARE;
  IF u_role IS DISTINCT FROM 'conductor' OR u_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'only an active conductor account can be assigned to a bus' USING ERRCODE = 'check_violation', CONSTRAINT = 'conductor_must_be_active_conductor';
  END IF;
  SELECT status INTO b_status FROM buses WHERE bus_id = NEW.bus_id FOR SHARE;
  IF b_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'a conductor can only be assigned to an active bus' USING ERRCODE = 'check_violation', CONSTRAINT = 'conductor_bus_must_be_active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conductor_assignments_check BEFORE INSERT OR UPDATE ON conductor_assignments
  FOR EACH ROW EXECUTE FUNCTION rw_check_conductor();

-- Backstops: an account that stops being an active conductor, or a bus that leaves service, loses the assignment.
CREATE FUNCTION rw_drop_conductor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN DELETE FROM conductor_assignments WHERE conductor = NEW.username;
  ELSE DELETE FROM conductor_assignments WHERE bus_id = NEW.bus_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_not_conductor AFTER UPDATE OF role, active ON users
  FOR EACH ROW WHEN (NEW.role <> 'conductor' OR NEW.active = false) EXECUTE FUNCTION rw_drop_conductor();
CREATE TRIGGER buses_leave_service_conductor AFTER UPDATE OF status ON buses
  FOR EACH ROW WHEN (NEW.status <> 'active') EXECUTE FUNCTION rw_drop_conductor();

-- A different person counting a bus (or nobody) must not inherit the previous count: it returns to "not reported".
CREATE FUNCTION rw_reset_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE buses SET passenger_count = NULL, occupancy_updated_at = NULL WHERE bus_id = OLD.bus_id AND passenger_count IS NOT NULL;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE buses SET passenger_count = NULL, occupancy_updated_at = NULL WHERE bus_id = NEW.bus_id AND passenger_count IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER conductor_assignments_reset_count AFTER INSERT OR UPDATE OR DELETE ON conductor_assignments
  FOR EACH ROW EXECUTE FUNCTION rw_reset_count();
