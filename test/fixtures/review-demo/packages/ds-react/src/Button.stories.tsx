import { Button } from './Button';
export default { title: 'Button', component: Button, args: { children: 'Button' } };
export const Default = {};
export const AllVariants = { render: () => <><Button>Button</Button><Button variant="outline">Button</Button><Button variant="ghost">Button</Button></> };
export const Icon = { args: { size: 'icon', 'aria-label': 'Add', children: <svg data-slot="icon" /> } };
