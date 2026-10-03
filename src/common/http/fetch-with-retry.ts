const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRIES = Number(process.env.HTTP_READ_RETRIES ?? 1);
const RETRY_DELAY_MS = 300;
const ATTEMPT_TIMEOUT_MS = 4000;

/**
 * fetch para LECTURAS entre servicios: si falla la red, se agota el tiempo o el
 * otro servicio responde 502/503/504, reintenta con espera creciente. No usar
 * en operaciones que modifican datos (no son seguras de repetir sin idempotencia).
 * Peor caso con la configuración por defecto: 2 intentos de 4 s + 300 ms.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= RETRIES) return res;
    } catch (err) {
      if (attempt >= RETRIES) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 3 ** attempt));
  }
}
