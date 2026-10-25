/**
 * E27 — política única de senha (convite, troca em "Minha conta" e redefinição). Pura, sem acesso a banco.
 * Mínimo 12 caracteres (já era a regra); recusa as óbvias: sequência/repetição, lista curta das mais comuns e o próprio e-mail.
 */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

const COMMON = new Set([
  "123456789012", "1234567890123", "123456123456", "111111111111", "000000000000", "qwertyuiop12", "qwertyuiopas", "qwerty123456",
  "senha1234567", "senha12345678", "senhasenha12", "minhasenha123", "mudar123456", "mudar@123456", "password1234", "password12345",
  "passw0rd1234", "abcdefghijkl", "abc123456789", "admin1234567", "administrador", "k3gfinance123", "k3gsolutions", "k3gsolutions1", "k3g@12345678",
]);

const lettersOnly = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function isRun(s: string): boolean {
  if (s.length < 2) return false;
  const code = [...s].map((c) => c.charCodeAt(0));
  const step = code[1] - code[0];
  if (Math.abs(step) > 1) return false;
  return code.every((c, i) => i === 0 || c - code[i - 1] === step); // 111111…, 123456…, abcdef…, 987654…
}

/** Mensagem do problema, ou null se a senha serve. `ctx.email` impede senha que contém o nome do usuário do e-mail. */
export function passwordProblem(pw: string, ctx: { email?: string } = {}): string | null {
  if (pw.length < MIN_PASSWORD) return `A senha deve ter ao menos ${MIN_PASSWORD} caracteres`;
  if (pw.length > MAX_PASSWORD) return "Senha longa demais";
  if (/^\d+$/.test(pw) && pw.length < 16) return "Senha só com números é fraca. Use também letras";
  const flat = lettersOnly(pw);
  if (isRun(flat)) return "Senha previsível (sequência ou repetição). Use uma frase ou palavras sem relação";
  if (COMMON.has(pw.toLowerCase()) || COMMON.has(flat)) return "Senha muito comum. Escolha outra";
  const local = lettersOnly((ctx.email ?? "").split("@")[0] ?? "");
  if (local.length >= 4 && flat.includes(local)) return "A senha não pode conter o seu e-mail";
  return null;
}

/** Força para o indicador da tela (0 a 4). Só orienta; quem decide é `passwordProblem`. */
export function passwordStrength(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return passwordProblem(pw) ? (Math.min(s, 1) as 0 | 1) : (Math.max(2, Math.min(s + 1, 4)) as 2 | 3 | 4);
}
