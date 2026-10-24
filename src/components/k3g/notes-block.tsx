import { SectionCard } from "@/components/k3g/primitives";
import { buttonClass } from "@/components/k3g/button";
import { formatDateTime } from "@/lib/format";

type Note = { id: string; body: string; at: Date; author: string };

/** Comentários só de acréscimo (E21): quem tem permissão escreve; ninguém edita nem apaga (o banco recusa). */
export function NotesBlock({ notes, action, hidden, canWrite }: { notes: Note[]; action: (fd: FormData) => Promise<void>; hidden: Record<string, string>; canWrite: boolean }) {
  return (
    <SectionCard title={`Comentários (${notes.length})`}>
      <div id="comentarios" />
      {canWrite && (
        <form action={action} className="mb-4 space-y-2">
          {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <label htmlFor="note-body" className="sr-only">Novo comentário</label>
          <textarea id="note-body" name="body" required maxLength={2000} rows={3} placeholder="Ex.: cliente pediu reajuste só em janeiro; combinado por telefone com a Ana." className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm" />
          <div className="flex flex-wrap items-center gap-3"><button className={buttonClass("outline")}>Adicionar comentário</button><span className="text-xs text-muted-foreground">Não dá para editar nem apagar depois.</span></div>
        </form>
      )}
      {notes.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum comentário ainda.</p> : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="text-sm"><p className="whitespace-pre-wrap break-words">{n.body}</p><p className="text-xs text-muted-foreground">{n.author} · {formatDateTime(n.at)}</p></li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
