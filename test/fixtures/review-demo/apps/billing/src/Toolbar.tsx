export function Toolbar({ rows, paidOnly, setPaidOnly, save, refresh }: any) {
  return (
    <section className="toolbar">
      <button className="btn btn-primary" onClick={save}>Save invoice</button>
      <button className="btn btn-outline">Export</button>
      <button className="icon-btn" aria-label="Refresh" onClick={refresh}><svg className="icon" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6" /></svg></button>
      <button className="icon-btn icon-hover" aria-label="Archive"><svg className="icon" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" /></svg></button>
      <button className="btn btn-ghost" aria-pressed={paidOnly} onClick={() => setPaidOnly(!paidOnly)}>Paid only</button>
      <nav className="tabs">{rows.map((r: any) => <button key={r.id} className="row-link">{r.name}</button>)}</nav>
      <table className="grid">
        <thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Amount</th><th>Due</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.id}><td>{r.id}</td><td>{r.name}</td><td>{r.status}</td><td>{r.amount}</td><td>{r.due}</td></tr>)}</tbody>
      </table>
    </section>
  );
}
