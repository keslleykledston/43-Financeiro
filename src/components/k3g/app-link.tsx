/** ÚNICO ponto de acoplamento com o roteador (no protótipo era o TanStack; aqui é next/link). */
import Link from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";

export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children: ReactNode;
}
export function AppLink({ href, children, ...rest }: AppLinkProps) {
  return <Link href={href} {...rest}>{children}</Link>;
}
