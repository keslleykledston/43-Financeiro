import { AcceptForm } from "./form";

export default async function Convite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-sm">
        <h1 className="text-2xl font-semibold">Aceitar convite</h1>
        <p className="mb-6 mt-1 text-sm text-slate-600">K3G Finance</p>
        <AcceptForm token={token} />
      </div>
    </main>
  );
}
