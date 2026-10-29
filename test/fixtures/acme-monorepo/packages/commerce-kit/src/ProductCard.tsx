import { Button, Card } from '@acme/ds-react';
export function ProductCard({ p }: any) {
  return (
    <Card>
      <h3>{p.name}</h3>
      <Button variant="primary">Add to cart</Button>
    </Card>
  );
}
