export const LOGIN_TTL_MS: number;
export function uniqueCookie(request: Request, name: string): string;
export function validSessionToken(value: unknown): value is string;
export interface LoginTransaction { state: string; verifier: string; expiresAt: number; [key: string]: unknown }
export function parseLoginTransaction(raw: string, params: URLSearchParams, now?: number): LoginTransaction | null;
