import { DataTable, Button, Select } from '@acme/ds-react';
import { ProductCard } from '@acme/commerce-kit';
export function Cart({ rows0, rows1, rows2, rows3, rows4, rows5 }: any) {
  return (
    <section>
      <DataTable className="cart-dense" rows={rows0} />
      <DataTable className="cart-dense" rows={rows1} />
      <DataTable className="cart-dense" rows={rows2} />
      <DataTable className="cart-dense" rows={rows3} />
      <DataTable className="cart-dense" rows={rows4} />
      <DataTable rows={rows5} />
      <ProductCard p={{ name: 'x' }} />
      <Button>Checkout</Button>
      <Select options={[]} />
      <select name="ship"><option>Ground</option></select>
      <select name="gift"><option>No</option></select>
      <select name="region"><option>US</option></select>
      <select name="country"><option>US</option></select>
    </section>
  );
}
