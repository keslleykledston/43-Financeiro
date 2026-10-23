import { signOut } from "@/auth";

// Encerra a sessão quando a conta foi desabilitada (usado por requireContext).
export async function GET() {
  await signOut({ redirectTo: "/login" });
}
