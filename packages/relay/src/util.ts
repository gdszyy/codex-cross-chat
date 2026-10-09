import { randomBytes, randomInt } from 'node:crypto';

const A36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
const A32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no I/O/0/1

export function nowMs(): number {
  return Date.now();
}

function pick(alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

export function newConvId(): string {
  return 'c-' + pick(A36, 6);
}

export function newDeviceId(): string {
  return 'dev-' + pick(A36, 4);
}

export function newDeviceToken(): string {
  return randomBytes(24).toString('hex');
}

export function newTicket(): string {
  return randomBytes(18).toString('hex');
}

export function newRequestId(): string {
  return 'r-' + randomBytes(8).toString('hex');
}

export function newJoinCode(): string {
  return pick(A32, 4) + '-' + pick(A32, 4);
}

export function newNoticeId(): string {
  return 'n-' + randomBytes(6).toString('hex');
}

export function newResultId(): string {
  return 'res-' + randomBytes(8).toString('hex');
}

/** HTTP-level error carrying a machine code and HTTP status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const bad = (code: string, message: string) => new HttpError(400, code, message);
export const unauth = (message = 'unauthorized') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string) =>
  new HttpError(403, code, message);
export const notFound = (code: string, message: string) =>
  new HttpError(404, code, message);
export const conflict = (code: string, message: string) =>
  new HttpError(409, code, message);
