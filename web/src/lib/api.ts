/**
 * api.ts — Typed API client for ARIA
 * Uses fetch with credentials: 'include' to send session cookies
 */

const BASE = import.meta.env.VITE_API_URL || '';

// Raw fetch with credentials + BASE URL — use when you need the full Response
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Auth

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'rep' | 'admin';
}

export async function login(email: string, password: string): Promise<{ user: User }> {
  return request('POST', '/api/auth/login', { email, password });
}

export async function logout(): Promise<void> {
  return request('POST', '/api/auth/logout');
}

export async function getMe(): Promise<{ user: User }> {
  return request('GET', '/api/auth/me');
}

// Customers

export interface Customer {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  source?: string;
  created_by?: string;
  created_at: string;
}

export interface CustomerInput {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  source?: string;
}

export async function createCustomer(data: CustomerInput): Promise<Customer> {
  return request('POST', '/api/customers', data);
}

export async function listCustomers(): Promise<Customer[]> {
  return request('GET', '/api/customers');
}

export async function getCustomer(id: string): Promise<Customer> {
  return request('GET', `/api/customers/${id}`);
}

// Meetings

export interface Meeting {
  id: string;
  customer_id?: string;
  rep_id: string;
  started_at: string;
  ended_at?: string;
  status: 'active' | 'completed' | 'cancelled';
  summary?: string;
  title?: string;
  rep_name?: string;
  customer_name?: string;
}

export async function createMeeting(customerId?: string): Promise<Meeting> {
  return request('POST', '/api/meetings', { customer_id: customerId });
}

export async function listMeetings(): Promise<Meeting[]> {
  return request('GET', '/api/meetings');
}

export async function getMeeting(id: string): Promise<Meeting> {
  return request('GET', `/api/meetings/${id}`);
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  ts: string;
}

export async function getLatestCoaching(id: string): Promise<{ coaching: unknown | null }> {
  return request('GET', `/api/meetings/${id}/coaching/latest`);
}

export async function deleteMeeting(id: string): Promise<void> {
  return request('DELETE', `/api/meetings/${id}`);
}

export async function getMeetingSegments(id: string): Promise<{ segments: TranscriptSegment[] }> {
  return request('GET', `/api/meetings/${id}/segments`);
}

export async function updateMeeting(
  id: string,
  data: Partial<Pick<Meeting, 'status' | 'ended_at' | 'summary' | 'title'>>
): Promise<Meeting> {
  return request('PATCH', `/api/meetings/${id}`, data);
}
