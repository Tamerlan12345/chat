import { useCallback } from 'react';
import { errorMessageFrom, httpError } from '../lib/admin-access.mjs';

// Запрос к серверу от имени администратора. Отказ превращается в Error с
// русским текстом: explain(data, status, fallback) — свой разбор тела, иначе
// общий; fallback — текст конкретного действия, когда тело ничего не объясняет.
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
      throw httpError((explain || errorMessageFrom)(data, res.status, fallback), res.status);
    }
    return res.json().catch(() => ({}));
  }, [serverUrl]);
}
