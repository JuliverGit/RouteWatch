// Status values the server sends, with the label and badge tone each one is shown with. Shared by several screens.
// Each screen falls back on its own (for example `?? "off"`) for a value missing here.

// How fresh a bus position is (decided by the server): current, delayed, stale (last known) or unavailable.
export const TRACK = { current: { label: "Live", tone: "ok" }, delayed: { label: "Delayed", tone: "warn" }, stale: { label: "Last known", tone: "bad" }, unavailable: { label: "Unavailable", tone: "off" } };
// Operational status of a bus (set by an administrator). This is NOT the GPS tracking status above.
export const BUS_STATUS = { active: { label: "Active", tone: "ok" }, maintenance: { label: "Under maintenance", tone: "warn" }, inactive: { label: "Inactive", tone: "off" } };

// Service alerts: severity, and the state the server derives (draft, active, expired, resolved).
export const SEV = { info: { tone: "info", label: "Information" }, warning: { tone: "warn", label: "Warning" }, critical: { tone: "bad", label: "Critical" } };
export const ASTATE = { draft: { tone: "off", label: "Draft" }, active: { tone: "ok", label: "Active" }, expired: { tone: "off", label: "Expired" }, resolved: { tone: "off", label: "Resolved" } };
