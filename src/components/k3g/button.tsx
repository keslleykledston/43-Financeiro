import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger" | "success";
export type ButtonSize = "md" | "sm";

const base = "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-60";
const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  success: "bg-positive text-background hover:bg-positive/90",
  outline: "border border-input bg-card text-foreground hover:bg-accent",
  ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
  danger: "border border-negative/40 bg-card text-negative-foreground hover:bg-negative-soft",
};
const sizes: Record<ButtonSize, string> = { md: "h-10 px-4 text-sm", sm: "h-8 px-3 text-xs" };

/** Classes de botão para <button>, <a> e <Link> — mantém o visual único sem componente polimórfico. */
export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string) => cn(base, variants[variant], sizes[size], extra);

export const inputClass = "h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground";
export const selectClass = "h-10 rounded-md border border-input bg-card px-3 text-sm text-foreground";
