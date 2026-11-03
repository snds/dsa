import { cva } from 'class-variance-authority';

// No stories: drawn from source by the review's harness.
const selectVariants = cva('ds-select', {
  variants: { size: { default: 'ds-select-md', sm: 'ds-select-sm' } },
  defaultVariants: { size: 'default' },
});

export function Select({ className, size, children, ...props }: any) {
  // A plain label becomes its one option.
  const options = typeof children === 'string' ? <option>{children}</option> : children;
  return <select data-slot="select" data-size={size ?? 'default'} className={selectVariants({ size, className })} {...props}>{options}</select>;
}
