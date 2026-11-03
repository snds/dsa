// No stories. Its rows come from data.
export function Table({ className, rows = [], ...props }: any) {
  return (
    <table data-slot="table" className={['ds-table', className].filter(Boolean).join(' ')} {...props}>
      <tbody>{rows.map((r: any, i: number) => <tr key={i}>{r.map((c: any, j: number) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}
