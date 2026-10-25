"use client";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { inputClass } from "./button";
import { passwordProblem, passwordStrength } from "@/modules/identity/password";

const LABEL = ["", "Fraca", "Razoável", "Boa", "Forte"];
const BAR = ["bg-muted", "bg-negative", "bg-warning", "bg-positive", "bg-positive"];

/** Nova senha + confirmação, com mostrar/ocultar e indicador de força. A regra de verdade é do servidor (passwordProblem); aqui só orienta. */
export function PasswordFields({ email, idPrefix = "pw" }: { email?: string; idPrefix?: string }) {
  const [pw, setPw] = useState(""); const [again, setAgain] = useState(""); const [show, setShow] = useState(false);
  const s = passwordStrength(pw);
  const problem = pw ? passwordProblem(pw, { email }) : null;
  const type = show ? "text" : "password";
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${idPrefix}-new`} className="mb-1 block text-sm font-medium">Nova senha</label>
        <div className="relative">
          <input id={`${idPrefix}-new`} name="password" type={type} value={pw} onChange={(e) => setPw(e.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required className={`${inputClass} pr-10`} aria-describedby={`${idPrefix}-hint`} />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Ocultar senhas" : "Mostrar senhas"} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground">
            {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2" aria-hidden>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full transition-all ${BAR[s]}`} style={{ width: `${s * 25}%` }} /></div>
          <span className="w-16 text-right text-xs text-muted-foreground">{pw ? LABEL[s] : ""}</span>
        </div>
        <p id={`${idPrefix}-hint`} className={`mt-1 text-xs ${problem ? "text-negative-foreground" : "text-muted-foreground"}`}>{problem ?? "Mínimo de 12 caracteres. Uma frase com palavras sem relação funciona bem."}</p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-confirm`} className="mb-1 block text-sm font-medium">Confirmar senha</label>
        <input id={`${idPrefix}-confirm`} name="confirm" type={type} value={again} onChange={(e) => setAgain(e.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required className={inputClass} />
        {again && again !== pw && <p role="alert" className="mt-1 text-xs text-negative-foreground">A confirmação não confere.</p>}
      </div>
    </div>
  );
}
