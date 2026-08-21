// LeadHunter Pro — service worker
// Handles push notifications so results can be announced even after the
// browser/tab has been backgrounded or fully closed.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'LeadHunter Pro', body: 'Your search has finished.' };
  try { if (event.data) data = event.data.json(); } catch (_) {}

  const options = {
    body: data.body || '',
    data: { jobId: data.jobId || null },
    tag: 'leadhunter-result',
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title || 'LeadHunter Pro', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
