-- RouteWatch migration 003: service alerts and user notifications (Phase 7).
-- Runs once (migrate.js records it in schema_migrations). It only ADDS two tables, their indexes and guard triggers;
-- nothing that migrations 001 and 002 created is changed, and no existing row is touched.
--
-- Design notes
--  * One table holds the alert itself (service_alerts). Which bus, route or stop it is about is a plain nullable
--    column of that table, not three more tables: an alert concerns at most one of each, so a join table would only
--    duplicate. A general announcement leaves all three empty.
--  * "Expired" is NOT a stored state. An alert is expired when status = 'published' and expires_at has passed. That is
--    computed when it is read, so nothing has to run in the background and an expired alert can never look active.
--  * Alerts are never deleted (history stays for audit): a draft or published alert ends as status 'resolved'.
--  * One row per (user, alert) in notifications: who was told about what, and when they read it. The text lives only in
--    the alert, so it is never stored twice. Rows are created when an alert is published, by the server, in the same
--    transaction that publishes it.
--
-- Recovery (only if this migration has to be undone; this destroys every alert and notification, take a pg_dump first):
--   DROP TABLE notifications; DROP TABLE service_alerts;
--   DROP FUNCTION rw_alert_guard(); DROP FUNCTION rw_notification_guard();
--   DELETE FROM schema_migrations WHERE version = 3;

CREATE TABLE service_alerts (
  alert_id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text        NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120 AND title !~ '[[:cntrl:]]'),
  description   text        NOT NULL CHECK (char_length(description) BETWEEN 5 AND 600),
  category      text        NOT NULL CHECK (category IN ('bus_delay', 'route_disruption', 'route_change', 'stop_closure', 'service_interruption', 'general')),
  severity      text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- 'public': everyone may see it (passengers, visitors on the map). 'staff': administrators, dispatchers and the conductors it concerns.
  audience      text        NOT NULL DEFAULT 'public' CHECK (audience IN ('public', 'staff')),
  status        text        NOT NULL DEFAULT 'draft'  CHECK (status IN ('draft', 'published', 'resolved')),
  bus_id        text        REFERENCES buses  (bus_id)   ON UPDATE RESTRICT ON DELETE RESTRICT,
  route_id      text        REFERENCES routes (route_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  stop_id       text        REFERENCES stops  (stop_id)  ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by    text        NOT NULL REFERENCES users (username) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  published_by  text        REFERENCES users (username) ON UPDATE RESTRICT ON DELETE RESTRICT,
  expires_at    timestamptz,
  resolved_at   timestamptz,
  resolved_by   text        REFERENCES users (username) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT alert_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at),
  -- The state and its timestamps always agree, whatever code writes the row.
  CONSTRAINT alert_state_fields CHECK (
    (status = 'draft'     AND published_at IS NULL     AND resolved_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL AND published_by IS NOT NULL AND resolved_at IS NULL) OR
    (status = 'resolved'  AND resolved_at IS NOT NULL  AND resolved_by IS NOT NULL))
);
CREATE INDEX service_alerts_published ON service_alerts (expires_at) WHERE status = 'published';
CREATE INDEX service_alerts_recent    ON service_alerts (created_at DESC, alert_id DESC);
CREATE INDEX service_alerts_bus       ON service_alerts (bus_id)   WHERE bus_id IS NOT NULL;
CREATE INDEX service_alerts_route     ON service_alerts (route_id) WHERE route_id IS NOT NULL;
CREATE INDEX service_alerts_stop      ON service_alerts (stop_id)  WHERE stop_id IS NOT NULL;

-- Lifecycle guard (defence in depth; the application checks first and gives clear messages):
--   draft -> published -> resolved, or draft -> resolved. Never backwards. A resolved alert is read-only.
--   Who made it and when never change. Once published, what the notifications were sent about (title, category,
--   audience, bus, route, stop) can no longer change; only the description, severity and expiry can be corrected.
CREATE FUNCTION rw_alert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'a resolved alert cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'alert_resolved_readonly';
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a published alert cannot go back to draft' USING ERRCODE = 'check_violation', CONSTRAINT = 'alert_no_unpublish';
  END IF;
  IF NEW.alert_id <> OLD.alert_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'alert identity cannot change' USING ERRCODE = 'check_violation', CONSTRAINT = 'alert_identity_immutable';
  END IF;
  IF OLD.status = 'published' AND (NEW.title <> OLD.title OR NEW.category <> OLD.category OR NEW.audience <> OLD.audience
     OR NEW.bus_id IS DISTINCT FROM OLD.bus_id OR NEW.route_id IS DISTINCT FROM OLD.route_id OR NEW.stop_id IS DISTINCT FROM OLD.stop_id) THEN
    RAISE EXCEPTION 'a published alert keeps its title, category, audience and links' USING ERRCODE = 'check_violation', CONSTRAINT = 'alert_published_immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER service_alerts_guard BEFORE UPDATE ON service_alerts
  FOR EACH ROW EXECUTE FUNCTION rw_alert_guard();

-- Who was told about which alert, and whether they have read it.
CREATE TABLE notifications (
  notification_id  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username         text        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
  alert_id         bigint      NOT NULL REFERENCES service_alerts (alert_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz,
  CONSTRAINT notifications_one_per_user_alert UNIQUE (username, alert_id)
);
CREATE INDEX notifications_user_recent ON notifications (username, created_at DESC, notification_id DESC);
CREATE INDEX notifications_user_unread ON notifications (username) WHERE read_at IS NULL;

-- Only "read" may change, and only once (a notification cannot be marked unread again or re-pointed at another user/alert).
CREATE FUNCTION rw_notification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notification_id <> OLD.notification_id OR NEW.username <> OLD.username OR NEW.alert_id <> OLD.alert_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'only the read time of a notification can change' USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_immutable';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'a read notification stays read' USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_stays_read';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_guard BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION rw_notification_guard();
