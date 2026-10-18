import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, ExpectOptions, HTTP_TIMEOUTS } from '../common/http/internal-http';

export interface LedgerAccountInfo {
  id: string;
  accountNumber: string | null;
  accountType: 'savings' | 'checking' | 'merchant';
  idUser: string;
  currency: string;
  status: string;
  dailyLimit?: number;
  monthlyLimit?: number;
}

/** Cuentas en account-service (solo lecturas). Errores: regla común de common/http/internal-http.ts. */
@Injectable()
export class AccountsClientService {
  constructor(private readonly config: ConfigService) {}

  async getOwnedAccount(accountId: string, accessToken: string): Promise<LedgerAccountInfo> {
    // 403 y 404 se responden igual: no se revela si la cuenta existe.
    const noAccess = () => new ForbiddenException('No tienes acceso a esta cuenta.');
    return this.read(
      `/accounts/${encodeURIComponent(accountId)}`,
      { Authorization: `Bearer ${accessToken}` },
      {
        internal: false,
        unavailable: 'No se pudo validar la cuenta. Inténtalo de nuevo.',
        on: { 403: noAccess, 404: noAccess },
      },
    );
  }

  async getInternalAccount(accountId: string): Promise<LedgerAccountInfo> {
    return this.read(`/internal/accounts/${encodeURIComponent(accountId)}/ledger-info`, this.internalHeaders(), {
      internal: true,
      unavailable: 'No se pudo validar la cuenta en Account Service.',
      on: { 404: () => new NotFoundException('Cuenta no encontrada') },
    });
  }

  async getInternalAccountByNumber(accountNumber: string): Promise<LedgerAccountInfo> {
    return this.read(
      `/internal/accounts/number/${encodeURIComponent(accountNumber)}/ledger-info`,
      this.internalHeaders(),
      {
        internal: true,
        unavailable: 'No se pudo validar la cuenta destino en Account Service.',
        on: { 404: () => new NotFoundException('Cuenta destino no encontrada') },
      },
    );
  }

  async getLimits(accountId: string, accessToken: string) {
    return this.read<{ dailyLimit: number; monthlyLimit: number }>(
      `/accounts/${encodeURIComponent(accountId)}/limits`,
      { Authorization: `Bearer ${accessToken}` },
      { internal: false, unavailable: 'No se pudieron consultar los límites de la cuenta.' },
    );
  }

  private read<T = LedgerAccountInfo>(
    path: string,
    headers: Record<string, string>,
    options: Omit<ExpectOptions, 'service'>,
  ): Promise<T> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    return callService<T>(
      `${baseUrl}${path}`,
      { headers, timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      { service: 'Account Service', ...options },
    );
  }

  private internalHeaders() {
    return { 'x-internal-key': this.config.get<string>('INTERNAL_API_KEY') || '' };
  }
}
