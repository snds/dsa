import { cva } from "class-variance-authority";
import { cn } from "./utils";

/** The button: stock shadcn variants plus the system's own (dark, toolbar), sized by its tokens. */
const acmeButtonVariants = cva("inline-flex shrink-0 items-center justify-center text-sm font-medium whitespace-nowrap cursor-pointer disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:bg-primary/90",
      outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      ghost: "hover:bg-accent hover:text-foreground",
      destructive: "bg-destructive text-white hover:bg-destructive/90",
      link: "text-primary underline-offset-4 hover:underline",
      dark: "bg-foreground text-background hover:bg-foreground/90",
      toolbar: "border-border bg-card text-foreground shadow-sm hover:bg-accent aria-expanded:bg-accent",
    },
    size: {
      default: "h-(--button-height) gap-1.5 rounded-(--button-radius) px-(--button-px)",
      xs: "h-(--button-height-xs) gap-1 rounded-(--button-radius) px-2 text-xs",
      sm: "h-(--button-height-sm) gap-1 rounded-(--button-radius) px-(--button-px) text-[0.8rem]",
      lg: "h-(--button-height-lg) gap-1.5 rounded-(--button-radius) px-(--button-px)",
      icon: "inline-grid size-(--button-height) place-items-center p-0 rounded-(--button-radius)",
      "icon-xs": "inline-grid size-(--button-height-xs) place-items-center p-0 rounded-(--button-radius)",
      "icon-sm": "inline-grid size-(--button-height-sm) place-items-center p-0 rounded-(--button-radius)",
      "icon-lg": "inline-grid size-(--button-height-lg) place-items-center p-0 rounded-(--button-radius)",
      toolbar: "h-(--button-height) gap-1.5 rounded-sm px-(--button-px)",
      "toolbar-icon": "inline-grid size-(--button-height) place-items-center p-0 rounded-sm",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({ className, variant = "default", size = "default", ...props }: any) {
  return <button data-slot="button" className={cn(acmeButtonVariants({ variant, size }), className)} {...props} />;
}

export { acmeButtonVariants as buttonVariants };
