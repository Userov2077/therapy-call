self.addEventListener('push', function(event) {
    console.log('[Service Worker] Получен Push-сигнал');

    let data = {};
    
    // Безопасно пытаемся прочитать то, что прислал сервер
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            // Если пришел не JSON, а обычный текст
            data = { title: 'Therapy Call', body: event.data.text() };
        }
    } else {
        // Если сервер прислал пустой пуш (просто "проснуться")
        data = { title: 'Therapy Call', body: 'У вас новое уведомление' };
    }

    const options = {
        body: data.body || '',
        vibrate: [200, 100, 200], // Вибрация для Android
        data: { url: data.url || '/' },
        requireInteraction: true // Чтобы не исчезало само
    };

    // Отрисовываем уведомление
    event.waitUntil(
        self.registration.showNotification(data.title || 'Уведомление', options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const urlToOpen = event.notification.data.url;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url.indexOf(self.location.origin) !== -1 && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});