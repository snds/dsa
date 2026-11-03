import { cva } from 'class-variance-authority';

// No stories, and no data-variant or data-size: its props show only in the classes cva adds.
const toggleVariants = cva('ds-toggle', {
  variants: {
    variant: { default: 'ds-toggle-plain', outline: 'ds-toggle-outline' },
    size: { default: 'ds-toggle-md', sm: 'ds-toggle-sm' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export function Toggle({ className, variant, size, pressed, ...props }: any) {
  return <button data-slot="toggle" aria-pressed={pressed ?? false} className={toggleVariants({ variant, size, className })} {...props} />;
}
