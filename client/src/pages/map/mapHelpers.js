import L from "leaflet";

export const busIcon = (id, status, mine = false, selected = false) => L.divIcon({ className: "", html: `<div class="bus-pin bus-pin--${status}${mine ? " bus-pin--mine" : ""}${selected ? " bus-pin--sel" : ""}">${id.slice(-2)}</div>${mine ? '<span class="bus-tag">MY BUS</span>' : ""}`, iconSize: [32, 32], iconAnchor: [16, 16] });
// The passenger's own position: a blue dot (drawn in CSS), clearly different from the round bus pins.
export const meIcon = L.divIcon({ className: "", html: '<div class="me-dot" aria-hidden="true"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
export const sourceLabel = (src) => (src === "gps" ? "GPS device" : src === "simulation" ? "Simulated GPS (not real)" : "No tracking device");
export const direction = (b) => (b.dir === 1 ? "To CDO" : b.dir === -1 ? "To Villanueva" : "Direction unknown");
export const nextStopOf = (b, stops) => {
  let best = null;
  (b.etas || []).forEach((e, i) => { if (e != null && (!best || e < best.eta)) best = { name: stops[i]?.name, eta: e }; });
  return best;
};
