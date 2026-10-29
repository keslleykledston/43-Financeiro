Fixtures SANITIZADAS do spike real da WAHA (CORE 2026.8.2, GOWS) de 2026-10-29. Sem chave, sem telefone e sem QR real.
Webhook (entrega 3): headers `X-Webhook-Hmac` (sha512 hex do corpo BRUTO com a chave de HMAC), `X-Webhook-Hmac-Algorithm: sha512`, `X-Webhook-Timestamp` (ms), `X-Webhook-Request-Id`;
corpo `{ id: "evt_…", timestamp, event: "session.status", session, me, payload: { name, status, statuses[] }, engine, environment }`. HMAC conferido contra o cálculo local nos 5 eventos recebidos.
