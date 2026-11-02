import { cva } from 'class-variance-authority';

const buttonVariants = cva('inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium', {
  variants: {
    variant: { default: 'bg-primary text-primary-foreground', outline: 'border bg-background', ghost: 'hover:bg-accent' },
    size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3', icon: 'size-9' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export function Button({ className, variant, size, ...props }: any) {
  return <button data-slot="button" data-variant={variant ?? 'default'} data-size={size ?? 'default'} className={buttonVariants({ variant, size, className })} {...props} />;
}
