# Подтверждение готовности релиза (Release Sign-Off)

**Проект**: CentyChat Mobile (iOS & Android)  
**Дата верификации**: 30 сентября 2026 г.  
**QA Lead / Agent**: QA Agent (CentyChat Mobile Team)  
**Статус**: **PASSED & APPROVED FOR RELEASE (ЗЕЛЕНЫЙ СВЕТ)**

---

## 1. Сводная верификация устраненных замечаний

| № | Платформа | Компонент | Первоначальное замечание | Статус исправления | Результат повторной проверки (Verification) |
|---|---|---|---|:---:|---|
| 1 | **Android** | `Attachment.kt` | DTO `FileUploadResponse` в snake_case; `FilePolicy` не соответствовал `openapi.yaml`. | ✅ Устранено | Поля приведены к контракту: `originalName`, `storedFilename`, `fileSize`, `mimeType`, `url`. `FilePolicy` содержит `enabled` и `allowed`. Покрыто unit-тестами `testFileUploadResponseCamelCaseDeserialization`, `testFilePolicyExtensionValidation`. |
| 2 | **Android** | `User.kt`, `ChatViewModel.kt` | В `RolePermissions` отсутствовало поле `is_admin`; проверка прав модератора была захардкожена как `roleName == "superadmin"`. | ✅ Устранено | Поля `is_admin` и `is_scoped_admin` добавлены в `RolePermissions`. `ChatViewModel.canDeleteMessage` проверяет `currentUser?.permissions?.isAdmin == true`. Покрыто тестом `testRolePermissionsAdminFlags`. |
| 3 | **Android** | `MainActivity.kt`, `ChangePasswordDialog.kt` | Модальное окно `must_change_password` было локализовано только в `LoginScreen` и могло быть отменено пользователем. | ✅ Устранено | В `MainActivity.kt` внедрено глобальное наблюдение за `mustChangePasswordFlow`. Диалог блокирует все экраны, параметр `onDismiss = null` делает его неотменяемым до успешной смены пароля. |
| 4 | **Android** | `CallScreen.kt`, `MainActivity.kt` | Отсутствовали runtime-запросы опасных разрешений `RECORD_AUDIO` и `POST_NOTIFICATIONS`. | ✅ Устранено | В `CallScreen.kt` внедрен `rememberLauncherForActivityResult(RequestPermission())` для `RECORD_AUDIO` с корректной обработкой отказа. В `MainActivity.kt` добавлен автоматический запрос `POST_NOTIFICATIONS` на Android 13+ (API 33+). |
| 5 | **Android** | `ApiClient.kt` | Отсутствовал 401 retry-интерцептор и авто-рефреш JWT токена. | ✅ Устранено | Внедрен потокобезопасный `OkHttp Authenticator`, выполняющий прозрачный рефреш через `/auth/refresh` и повтор исходного HTTP-запроса с новым `Bearer` токеном. Исключена рекурсия для эндпоинтов авторизации. |
| 6 | **iOS** | `PrivacyInfo.xcprivacy` | Массив `NSPrivacyCollectedDataTypes` был пуст, что создавало высокий риск реджекта Apple по Privacy Nutrition Labels. | ✅ Устранено | Задекларированы все 7 собираемых типов данных: `Name`, `EmailAddress`, `PhoneNumber`, `UserID`, `EmailsOrTextMessages`, `AudioData`, `PhotosOrVideos` с целями `AppFunctionality` и связью с личностью (`Linked = true`). |
| 7 | **iOS** | `Info.plist` | В `UIBackgroundModes` был задекларирован `voip` без интеграции CallKit (риск отказа по Guideline 2.5.4); отсутствовал `NSPhotoLibraryAddUsageDescription`. | ✅ Устранено | Ключ `voip` исключен из `UIBackgroundModes` (оставлены `audio`, `fetch`, `remote-notification`). Добавлено описание `NSPhotoLibraryAddUsageDescription` («Для сохранения вложений и изображений из переписки в медиатеку»). |

---

## 2. Итоговая матрица соответствия критериям приемки

```
+-------------------------------------------------------------+----------+
| Критерий приемки (Release Criteria)                         | Статус   |
+-------------------------------------------------------------+----------+
| Feature Parity между iOS и Android (20/20 модулей)          | PASSED   |
| Модели данных и DTO строго по OpenAPI 3.1                   | PASSED   |
| WebSocket протокол (текстовые события + бинарный 1028Б)     | PASSED   |
| Silence Gating (< 0.0015) и Jitter Buffer (60..250 мс)      | PASSED   |
| Окна редактирования/удаления сообщений (-1, 0, >0 мин)      | PASSED   |
| Защита от спама побудки (кулдаун 60 секунд)                 | PASSED   |
| Принудительная блокировка must_change_password              | PASSED   |
| Авто-рефреш JWT при 401 Unauthorized (iOS & Android)        | PASSED   |
| Манифест конфиденциальности Apple (PrivacyInfo.xcprivacy)   | PASSED   |
| Описания разрешений iOS (Info.plist)                        | PASSED   |
| Google Play Target SDK 35 (Android 15) Edge-to-Edge         | PASSED   |
| Runtime Permissions (RECORD_AUDIO, POST_NOTIFICATIONS)      | PASSED   |
+-------------------------------------------------------------+----------+
```

---

## 3. Заключение QA

Обе мобильные платформы CentyChat (**iOS** и **Android**) полностью соответствуют функциональным и платформенным требованиям, готовы к внутренней дистрибуции (TestFlight / Internal Testing Track) и прохождению модерации в **App Store** и **Google Play**.

**Вердикт QA Agent**: **РЕЛИЗ СОГЛАСОВАН (SIGN-OFF APPROVED)**.
