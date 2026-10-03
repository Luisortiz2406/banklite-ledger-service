import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchWithRetry } from '../common/http/fetch-with-retry';

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

@Injectable()
export class AccountsClientService {
  constructor(private readonly config: ConfigService) {}

  async getOwnedAccount(accountId: string, accessToken: string): Promise<LedgerAccountInfo> {
    const response = await this.fetchAccount(`/accounts/${encodeURIComponent(accountId)}`, {
      Authorization: `Bearer ${accessToken}`,
    });
    if (response.status === 403 || response.status === 404) {
      throw new ForbiddenException('No tienes acceso a esta cuenta.');
    }
    if (response.status === 401) throw new UnauthorizedException('La sesión no es válida para consultar la cuenta.');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar la cuenta.');
    return response.body as LedgerAccountInfo;
  }

  async getInternalAccount(accountId: string): Promise<LedgerAccountInfo> {
    const response = await this.fetchAccount(
      `/internal/accounts/${encodeURIComponent(accountId)}/ledger-info`,
      { 'x-internal-key': this.config.get<string>('INTERNAL_API_KEY') || '' },
    );
    if (response.status === 404) throw new NotFoundException('Cuenta no encontrada');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar la cuenta en Account Service.');
    return response.body as LedgerAccountInfo;
  }

  async getInternalAccountByNumber(accountNumber: string): Promise<LedgerAccountInfo> {
    const response = await this.fetchAccount(
      `/internal/accounts/number/${encodeURIComponent(accountNumber)}/ledger-info`,
      { 'x-internal-key': this.config.get<string>('INTERNAL_API_KEY') || '' },
    );
    if (response.status === 404) throw new NotFoundException('Cuenta destino no encontrada');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar la cuenta destino en Account Service.');
    return response.body as LedgerAccountInfo;
  }

  async getLimits(accountId: string, accessToken: string) {
    const response = await this.fetchAccount(`/accounts/${encodeURIComponent(accountId)}/limits`, {
      Authorization: `Bearer ${accessToken}`,
    });
    if (!response.ok) throw new ServiceUnavailableException('No se pudieron consultar los límites de la cuenta.');
    return response.body as { dailyLimit: number; monthlyLimit: number };
  }

  private async fetchAccount(path: string, headers: Record<string, string>) {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    let response: Response;
    try {
      response = await fetchWithRetry(`${baseUrl}${path}`, { headers });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar Account Service.');
    }
    const body = await response.json().catch(() => ({}));
    if (response.status >= 500) throw new ServiceUnavailableException('Account Service no está disponible.');
    return { status: response.status, ok: response.ok, body };
  }
}