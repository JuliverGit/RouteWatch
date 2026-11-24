// Small status labels. The tone selects the colour class (badge--ok, badge--warn, badge--bad, badge--info, badge--off).
export const Badge = ({ tone, children }) => <span className={`badge badge--${tone}`}>{children}</span>;
// Passenger occupancy as the server reports it (real count kept by the bus's conductor). "Not reported" is shown as such, never as 0.
export const OccBadge = ({ occ }) => (occ && occ.reported ? <Badge tone={occ.tone}>{occ.count}/{occ.capacity} · {occ.label}</Badge> : <Badge tone="off">Occupancy not reported</Badge>);
