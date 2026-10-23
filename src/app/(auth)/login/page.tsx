import { LoginForm } from "./form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-sm">
        <h1 className="text-2xl font-semibold">K3G Finance</h1>
        <p className="mb-6 mt-1 text-sm text-slate-600">Acesse com seu e-mail corporativo.</p>
        <LoginForm />
      </div>
    </main>
  );
}
