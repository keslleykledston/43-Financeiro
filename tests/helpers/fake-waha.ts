import { WahaError, type WahaClient, type WahaSession } from "@/modules/providers/waha";
import type { SendResult } from "@/modules/providers/types";

/** WAHA falsa em memória, com o comportamento controlado pelo teste. */
export class FakeWaha implements WahaClient {
  sessions = new Map<string, WahaSession>();
  sent: { session: string; chatId: string; text: string }[] = [];
  calls: string[] = [];
  down = false;
  getCount = 0;
  dropOnGet = 0; // a partir da N-ésima leitura de estado a conexão aparece parada (cai entre avaliar e enviar)
  refOverride = "";
  exists: "yes" | "no" | "error" = "yes";
  pnOverride = ""; // devolve outro id canônico (9º dígito ou número diferente)
  checked: string[] = [];
  sendMode: "ok" | "unknown" | "fail" = "ok";
  private guard() { if (this.down) throw new WahaError("network", 0, "nao_enviado"); }
  async health() { return !this.down; }
  async createSession(name: string) { this.calls.push("create"); this.guard(); const s = { name, status: "SCAN_QR_CODE", meId: null, engine: "GOWS" }; this.sessions.set(name, s); return s; }
  async getSession(name: string) { this.calls.push("get"); this.guard(); this.getCount++; const s = this.sessions.get(name); if (s && this.dropOnGet && this.getCount >= this.dropOnGet) return { ...s, status: "STOPPED" }; return s ?? null; }
  async startSession(name: string) { this.calls.push("start"); this.guard(); const s = this.sessions.get(name)!; s.status = "SCAN_QR_CODE"; return s; }
  async stopSession(name: string) { this.calls.push("stop"); this.guard(); const s = this.sessions.get(name); if (s) { s.status = "STOPPED"; s.meId = null; } }
  async logoutSession(name: string) { this.calls.push("logout"); this.guard(); const s = this.sessions.get(name); if (!s || s.status !== "WORKING") throw new WahaError("http", 422, "http_422"); s.meId = null; }
  async qr(name: string) { this.calls.push("qr"); this.guard(); if (this.sessions.get(name)?.status !== "SCAN_QR_CODE") throw new WahaError("http", 422, "http_422"); return Buffer.from("PNGfake"); }
  onCheck: (() => Promise<void>) | null = null; // gancho do teste: roda no instante da consulta (simula algo mudando no meio do envio)
  async checkNumber(_s: string, digits: string) {
    this.calls.push("check"); this.checked.push(digits);
    if (this.onCheck) await this.onCheck();
    if (this.exists === "error") throw new WahaError("timeout");
    if (this.exists === "no") return { exists: false, chatId: null };
    if (this.pnOverride === "SEM_PN") return { exists: true, chatId: null };
    return { exists: true, chatId: this.pnOverride || `${digits}@c.us` };
  }
  async sendText(m: { session: string; chatId: string; text: string }): Promise<SendResult> {
    this.calls.push("send");
    if (this.sendMode === "unknown") return { ok: false, retryable: false, unknown: true, error: "sem_confirmacao" };
    if (this.sendMode === "fail") return { ok: false, retryable: false, error: "http_400" };
    this.sent.push(m); return { ok: true, providerRef: this.refOverride || `ref-${this.sent.length}` };
  }
  connect(name: string, phone = "5592988887777") { const s = this.sessions.get(name)!; s.status = "WORKING"; s.meId = `${phone}@c.us`; }
}

