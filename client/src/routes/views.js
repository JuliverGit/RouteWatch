import { Bus, Map as MapIcon, LayoutDashboard, Bell, MapPin, Users, ScrollText, Route as RouteIcon, Ticket, Megaphone } from "lucide-react";

// Display names only. What a user may actually do is decided by the server;
// the permission list it returns is used here just to show the right menu items.
export const VIEWS = [
  { id: "dash", label: "Dashboard", Icon: LayoutDashboard, permission: null, group: "Monitoring" }, // everyone; the server decides which sections they receive
  { id: "counter", label: "Passenger counter", Icon: Ticket, permission: "occupancy:update", group: "Monitoring" }, // conductors only (the server checks the assignment)
  { id: "map", label: "Live map", Icon: MapIcon, permission: null, group: "Monitoring" },
  { id: "notifications", label: "Notifications", Icon: Bell, permission: null, member: true, group: "Monitoring" }, // signed-in users only; each sees only their own
  { id: "alerts", label: "Service alerts", Icon: Megaphone, permission: "alerts:manage", group: "Operations" }, // administrators and dispatchers
  { id: "buses", label: "Buses", Icon: Bus, permission: "buses:read", group: "Fleet" },
  { id: "routes", label: "Routes", Icon: RouteIcon, permission: "routes:read", group: "Fleet" },
  { id: "stops", label: "Bus stops", Icon: MapPin, permission: "stops:read", group: "Fleet" },
  { id: "users", label: "Users", Icon: Users, permission: "users:read", group: "Administration" },
  { id: "audit", label: "Audit log", Icon: ScrollText, permission: "audit:read", group: "Administration" },
];
