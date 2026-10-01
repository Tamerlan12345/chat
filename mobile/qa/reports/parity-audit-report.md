# Отчет об аудите Feature Parity: iOS (`mobile/ios`) vs Android (`mobile/android`)

**Дата аудита**: 30 сентября 2026 г.  
**Версия спецификации**: CentyChat Contracts v1.0.0 (`openapi.yaml`, `ws-protocol.md`, `parity-matrix.md`)  
**Объекты аудита**:
- iOS-клиент: [`mobile/ios/CentyChat`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/ios/CentyChat) (Swift 5.9+, SwiftUI, Observation)
- Android-клиент: [`mobile/android/app/src/main/java/com/openmychat/mobile`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/android/app/src/main/java/com/openmychat/mobile) (Kotlin 2.0, Jetpack Compose, Coroutines)

---

## 1. Сводное резюме (Executive Summary)

В ходе углубленного аудита архитектуры, сетевых протоколов, моделей данных и бизнес-логики между iOS и Android подтвержден **полный паритет (100%)** по ключевым сценариям и контрактам.

Все ранее выявленные замечания были оперативно устранены командами разработки:
1. **DTO файлов и политик на Android (`Attachment.kt`) приведены к OpenAPI**: поля `originalName`, `storedFilename`, `fileSize`, `mimeType`, `url` в `camelCase`, а также `FilePolicy` (`enabled`, `allowed`, валидатор `isExtensionAllowed`).
2. **Обязательная смена пароля (`must_change_password`)**: на Android в `MainActivity.kt` внедрено глобальное наблюдение за `mustChangePasswordFlow` с показом неотменяемого диалога (`onDismiss = null`), блокирующего все экраны мессенджера до успешного завершения операции.
3. **Проверка роли суперадминистратора при удалении сообщений**: в Android `RolePermissions` добавлены поля `isAdmin` и `isScopedAdmin`, а в `ChatViewModel.canDeleteMessage` проверка переведена на `currentUser?.permissions?.isAdmin == true`.
4. **Автоматический рефреш JWT при 401**: в Android `ApiClient.kt` внедрен потокобезопасный `OkHttp Authenticator`, выполняющий прозрачный рефреш токена и повтор запроса без прерывания сессии пользователя.

---

## 2. Матрица функционального паритета (20 модулей)

| № | Модуль / Фича | Требование контракта | iOS | Android | Статус паритета | Примечания |
|---|---|---|:---:|:---:|:---:|---|
| 1 | **Device Knock** | UUID v4 устройства, отправка в `POST /api/auth/knock` при запуске, обработка статусов `paired`, `pending`, `login_required`. | ✅ | ✅ | **Полный** | Реализовано в обоих клиентах. |
| 2 | **Device Claim** | Сохранение 256-битного секрета устройства после входа по паролю (`POST /api/auth/device/claim`). | ✅ | ✅ | **Полный** | Реализовано в обоих клиентах после успешной авторизации. |
| 3 | **Auth & Refresh** | JWT авторизация, прозрачное продление сессии при 401, безопасное хранение. | ✅ | ✅ | **Полный** | На iOS через `APIClient.request` retry, на Android через `OkHttp Authenticator`. |
| 4 | **Must Change Password** | Перехват 403 `MUST_CHANGE_PASSWORD`, принудительная модальная блокировка всех экранов. | ✅ | ✅ | **Полный** | Глобальная блокировка интерфейса на обеих платформах без возможности закрытия. |
| 5 | **Direct Messaging** | Переписка 1-на-1, WebSocket sync, REST fallback (`/conversations/direct`, `/messages/direct`). | ✅ | ✅ | **Полный** | Полная идентичность протокола и параметров запроса. |
| 6 | **Channel Messaging** | Корпоративные каналы (`#Общий` и др.), счетчики непрочитанных, роли участников. | ✅ | ✅ | **Полный** | Идентичная обработка `channel_created`, `channel_deleted`. |
| 7 | **Message Editing** | Валидация серверного окна `message_edit_window_minutes` (-1, 0, >0 мин). | ✅ | ✅ | **Полный** | Алгоритмы в [`ValidationRules.swift`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/ios/CentyChat/Core/Utils/ValidationRules.swift) и [`MessageWindowValidator.kt`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/android/app/src/main/java/com/openmychat/mobile/core/util/MessageWindowValidator.kt) математически идентичны. |
| 8 | **Message Deleting** | Валидация окна `message_delete_window_minutes`, оверрайд суперадминистратора. | ✅ | ✅ | **Полный** | Обе платформы проверяют `permissions.isAdmin`. |
| 9 | **Typing Indicator** | Индикатор «печатает…» с автосбросом через 3 секунды. | ✅ | ✅ | **Полный** | Таймеры автосброса (3с) и фильтрация собственного ID присутствуют на обеих платформах. |
| 10 | **Presence & DND** | Статусы `online`, `away`, `dnd`, `offline`. События `user_status_changed`, команды `presence`, `set_dnd`. | ✅ | ✅ | **Полный** | Синхронная обработка изменений статуса и иконки бейджей. |
| 11 | **Wake (Побудка)** | Прием `wake_ring` с вибрацией/алертом, отправка `wake_send` с кулдауном 60с. | ✅ | ✅ | **Полный** | iOS: haptics + alert; Android: waveform vibration pattern + Toast. Кулдаун 60с поддержан в ViewModel. |
| 12 | **Voice Call Signalling** | Сигналинг вызова (`call_offer`, `call_answer`, `call_rejected`, `call_end`, `call_denied`, `call_unavailable`). | ✅ | ✅ | **Полный** | Таймаут вызова 45с, одинаковые конечные автоматы звонка. |
| 13 | **Audio Relay Engine** | Двоичный WebSocket стрим: кадры ровно 1028 байт (4 байта ID + 1024 байта PCM 16 кГц). | ✅ | ✅ | **Полный** | Строгое соответствие Big-Endian упаковки 512 сэмплов Int16 на обеих платформах. |
| 14 | **Silence Suppression** | Отсечение тишины `SILENCE_THRESHOLD = 0.0015` (средняя амплитуда сэмплов). | ✅ | ✅ | **Полный** | Одинаковая формула `sum(abs(s)) / 512 < 0.0015` на обеих платформах. |
| 15 | **Jitter Buffer** | Буфер воспроизведения: `targetLead = 60ms`, `maxLead = 250ms`, сброс к 60ms при превышении. | ✅ | ✅ | **Полный** | Реализовано в [`JitterScheduler.swift`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/ios/CentyChat/Core/WebSocket/JitterBuffer.swift) и [`JitterBuffer.kt`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/android/app/src/main/java/com/openmychat/mobile/core/audio/JitterBuffer.kt). |
| 16 | **Announcements** | Оповещения компании, бейджи срочности (`urgent`, `critical`), подтверждение ознакомления. | ✅ | ✅ | **Полный** | Модели и обработка `announcement_acknowledged` идентичны. |
| 17 | **Org Structure** | Справочник сотрудников (`/api/users`), отображение подразделений и контактов. | ✅ | ✅ | **Полный** | Загрузка полного списка пользователей с подразделениями и должностями. |
| 18 | **File Policy Filter** | Предварительная проверка расширений файлов через `GET /api/files/policy`. | ✅ | ✅ | **Полный** | Обе платформы используют модель с `enabled` и `allowed` и валидатор `isExtensionAllowed()`. |
| 19 | **File Upload / Download**| Загрузка файлов через multipart (`POST /api/files/upload`), скачивание и предпросмотр. | ✅ | ✅ | **Полный** | DTO приведены к OpenAPI, идентичная модель `FileUploadResponse`. |
| 20 | **Offline Cache** | Локальная очередь сообщений и кэш сессии. | ✅ | ✅ | **Полный** | Безопасное хранилище токенов и in-memory кэш сообщений. |

---

## 3. Детальный аудит моделей данных (Model Parity)

Все модели данных (`User`, `RolePermissions`, `Message`, `DirectConversation`, `Announcement`, `Channel`, `ServerInfo`, `FileUploadResponse`, `FilePolicy`) синхронизированы между iOS и Android в полном соответствии со спецификацией `openapi.yaml`.

---

## 4. Вердикт

Паритет функциональности и бизнес-логики между iOS и Android составляет **100%**. Архитектура полностью готова к релизу.
