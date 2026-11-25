import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

// Zooms the map to the stops of the route the visitor picked.
export function Fit({ points }) {
  const map = useMap();
  useEffect(() => { if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Moves the map to a point once per request (the "My bus" shortcut). A new `token` asks for another move.
export function FlyTo({ pos, token }) {
  const map = useMap();
  const done = useRef(0);
  const key = pos ? `${pos[0]},${pos[1]}` : "";
  useEffect(() => {
    if (token > done.current && pos) { done.current = token; map.flyTo(pos, Math.max(map.getZoom(), 15), { duration: 0.8 }); }
  }, [token, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Flies to the bus a passenger picked in the Nearby list and opens its popup. Once per pick (token), never on every position update.
export function FocusBus({ id, pos, token, markers }) {
  const map = useMap();
  const done = useRef(0);
  useEffect(() => {
    if (!token || token <= done.current || !pos) return;
    done.current = token;
    const open = () => markers.current.get(id)?.openPopup();
    map.once("moveend", open);
    const fallback = setTimeout(open, 1000); // in case the map was already there and no move happens
    map.flyTo(pos, Math.max(map.getZoom(), 15), { duration: 0.8 });
    return () => { map.off("moveend", open); clearTimeout(fallback); };
  }, [token, !!pos]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
