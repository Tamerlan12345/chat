import { useCallback } from 'react';
import { errorMessageFrom } from '../lib/admin-access.mjs';

// Запрос к серверу от имени администратора. Отказ превращается в Error с
// русским текстом: explain(data, status) — свой разбор тела, иначе общий.
export function useAdminApi(serverUrl) {
  return useCallback(async (path, { method = 'GET', body, fallback = 'Сервер отклонил запрос', explain } = {}) => {
    const token = localStorage.getItem('mychat_token') || '';
    let res;
    try {
      res = await fetch(serverUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new Error('Нет связи с сервером');
    }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      throw new Error((explain || ((d, s) => errorMessageFrom(d, s, fallback)))(data, res.status));
    }
    return res.json().catch(() => ({}));
  }, [serverUrl]);
}
