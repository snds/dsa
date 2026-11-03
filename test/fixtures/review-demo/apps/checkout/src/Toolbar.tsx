export function Toolbar({ save }: any) {
  return (
    <section className="toolbar">
      <button className="btn btn-primary" onClick={save}>Place order</button>
      <button className="btn btn-outline">Export</button>
      <button className="icon-btn" aria-label="Refresh"><svg className="icon" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6" /></svg></button>
    </section>
  );
}
