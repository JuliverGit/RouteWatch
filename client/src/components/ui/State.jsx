// A whole-page message: loading, empty, error or access denied, with an optional action (usually a button).
export const State = ({ title, text, action }) => (
  <div className="state" role="status"><h2>{title}</h2><p>{text}</p>{action}</div>
);
