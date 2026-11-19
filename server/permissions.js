// Role -> permission matrix. This is the single source of truth for authorization.
// Default deny: a permission or role that is not listed here grants nothing.
export const ROLES = ["admin", "dispatcher", "conductor", "passenger"];

export const PERMISSIONS = {
  "fleet:view": ["admin", "dispatcher"], // operations dashboard (fleet status)
  "users:read": ["admin"],               // list accounts
  "users:manage": ["admin"],             // change another user's role / active status
  "audit:read": ["admin"],               // view audit records
  "buses:read": ["admin", "dispatcher"], // bus registry (plate, capacity, status, devices)
  "buses:manage": ["admin"],             // register, edit, deactivate buses and change their status
  "routes:read": ["admin", "dispatcher"], // all routes (also inactive), their stops and assigned buses
  "routes:manage": ["admin"],            // create/edit/deactivate routes, order their stops, assign buses
  "stops:read": ["admin", "dispatcher"], // all bus stops (also inactive)
  "stops:manage": ["admin"],             // create/edit/deactivate bus stops
  "occupancy:update": ["conductor"],     // count passengers on and off the bus the conductor is assigned to (assignment is checked separately)
  "conductors:read": ["admin", "dispatcher"], // which conductor counts which bus
  "conductors:manage": ["admin"],        // assign a conductor to a bus or remove the assignment
  "alerts:manage": ["admin", "dispatcher"], // create, edit, publish and resolve service alerts (dispatchers: operational categories only; alerts.js decides)
};

export const isRole = (role) => typeof role === "string" && ROLES.includes(role);
export const can = (role, permission) => isRole(role) && Object.hasOwn(PERMISSIONS, permission) && PERMISSIONS[permission].includes(role);
export const permissionsFor = (role) => Object.keys(PERMISSIONS).filter((p) => can(role, p));
