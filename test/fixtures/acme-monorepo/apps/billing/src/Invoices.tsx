import { DataTable, Select, OldModal } from '@acme/ds-react';
export function Invoices({ r }: any) {
  return (
    <div>
      <DataTable className="inv" style={{ height: 28 }} rows={r} />
      <DataTable className="inv" style={{ height: 28 }} rows={r} />
      <DataTable className="inv" style={{ height: 28 }} rows={r} />
      <DataTable className="inv" style={{ height: 28 }} rows={r} />
      <DataTable className="inv" style={{ height: 28 }} rows={r} />
      <DataTable rows={r} />
      <Select options={[]} />
      <select><option>Paid</option></select>
      <select><option>Due</option></select>
      <select><option>USD</option></select>
      <select><option>Net 30</option></select>
      <OldModal open />
      <OldModal open={false} />
    </div>
  );
}
