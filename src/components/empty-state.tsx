export function EmptyState({ title, text, next }: { title: string; text: string; next: string }) {
  return (
    <section className="rounded-2xl bg-white p-8 text-center shadow-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-slate-600">{text}</p>
      <p className="mt-4 text-sm text-slate-500">Próxima entrega: {next}</p>
    </section>
  );
}
