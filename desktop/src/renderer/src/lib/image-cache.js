// Загруженные картинки переписки. Маршрут скачивания требует токен, а <img>
// заголовок авторизации отправить не может — поэтому картинка скачивается
// запросом и показывается как blob. Кэш нужен, чтобы лента и просмотр не
// скачивали один и тот же файл дважды, а прокрутка туда-обратно не мигала.

const MAX_ENTRIES = 60;
const cache = new Map(); // fileId -> Promise<string objectUrl>

export function loadImage(fileId, { serverUrl, token }) {
  const key = String(fileId);
  if (cache.has(key)) {
    const hit = cache.get(key);
    // Свежий доступ — в конец очереди на вытеснение.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = fetch(`${serverUrl}/api/files/download/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(async (res) => {
    if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
    return URL.createObjectURL(await res.blob());
  });
  // Неудачу не запоминаем: следующий показ попробует снова.
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);

  while (cache.size > MAX_ENTRIES) {
    const [oldKey, oldValue] = cache.entries().next().value;
    cache.delete(oldKey);
    oldValue.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
  return pending;
}
