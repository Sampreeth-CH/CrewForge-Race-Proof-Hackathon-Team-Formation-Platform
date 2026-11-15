import axios from 'axios';

let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null) {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export const API_BASE = `${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/api`;

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  if (inMemoryToken && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${inMemoryToken}`;
  }
  return config;
});

export function extractApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: { message?: string }; message?: string } | undefined;
    return data?.error?.message || data?.message || err.message || 'Request failed';
  }
  if (err instanceof Error) return err.message;
  return 'Unexpected error';
}

export function newIdempotencyKey(prefix = 'cf'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
