# Отчет о готовности к публикации в магазинах приложений (Store Readiness Report)

**Дата аудита**: 30 сентября 2026 г.  
**Платформы**:
- **Apple App Store** (iOS 17.0+ / Xcode 16 / Swift 5.9+)
- **Google Play Store** (Android 8.0+ API 26 / Target SDK 35 Android 15)

---

## 1. Сводная оценка готовности (Readiness Scorecard)

```
+------------------------------------+------------------+-----------------------+
| Магазин приложений                | Текущий статус   | Риск отклонения (Risk)|
+------------------------------------+------------------+-----------------------+
| Apple App Store                    | ✅ ГОТОВО К РЕЛИЗУ| НИЗКИЙ (Все требования соблюдены) |
| Google Play Store                  | ✅ ГОТОВО К РЕЛИЗУ| НИЗКИЙ (Все блокеры устранены)   |
+------------------------------------+------------------+-----------------------+
```

---

## 2. Apple App Store Review Audit

### 2.1. Аудит манифеста конфиденциальности (`PrivacyInfo.xcprivacy`)

Файл расположен в [`mobile/ios/CentyChat/Resources/PrivacyInfo.xcprivacy`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/ios/CentyChat/Resources/PrivacyInfo.xcprivacy).

| Секция манифеста | Статус в проекте | Требование Apple | Замечания и вердикт |
|---|:---:|---|---|
| `NSPrivacyTracking` | `<false/>` | Обязательно | ✅ Соответствует. Трекинг пользователей через IDFA и сторонние рекламные сети отсутствует. |
| `NSPrivacyTrackingDomains` | `<array/>` | Обязательно | ✅ Соответствует. Домены трекинга отсутствуют. |
| `NSPrivacyAccessedAPITypes` | Задекларированы 3 API | Обязательно для Required Reason APIs | ✅ Задекларированы: `UserDefaults` (`CA92.1`), `FileTimestamp` (`C617.1`), `DiskSpace` (`E174.1`). |
| `NSPrivacyCollectedDataTypes` | Задекларированы 7 типов | Обязательно при сборе персональных данных | ✅ **ПОЛНОСТЬЮ СООТВЕТСТВУЕТ**: внесены все собираемые типы (`Name`, `EmailAddress`, `PhoneNumber`, `UserID`, `EmailsOrTextMessages`, `AudioData`, `PhotosOrVideos`) с назначением `AppFunctionality` и привязкой к профилю (`Linked = true`). |

---

### 2.2. Аудит описания разрешений (`Info.plist` Usage Descriptions)

Файл расположен в [`mobile/ios/CentyChat/Resources/Info.plist`](file:///c:/Users/user/Documents/Нет%20в%20репо/chat/mobile/ios/CentyChat/Resources/Info.plist).

| Ключ разрешения | Присутствует | Текст обоснования (Usage Description) | Оценка |
|---|:---:|---|:---:|
| `NSMicrophoneUsageDescription` | ✅ | *«CentyChat требует доступ к микрофону для проведения корпоративных защищённых голосовых звонков между сотрудниками.»* | Соответствует |
| `NSCameraUsageDescription` | ✅ | *«CentyChat требует доступ к камере для отправки фотографий в корпоративный чат и обновления аватара профиля.»* | Соответствует |
| `NSPhotoLibraryUsageDescription` | ✅ | *«CentyChat требует доступ к медиатеке для отправки изображений, документов и вложений в чаты.»* | Соответствует |
| `NSPhotoLibraryAddUsageDescription` | ✅ | *«Для сохранения вложений и изображений из переписки в медиатеку.»* | Соответствует |

---

### 2.3. Аудит App Store Review Guidelines

1. **Guideline 2.5.4 (Background Modes)**:
   - Ключ `voip` успешно удален из `UIBackgroundModes` во избежание реджекта из-за отсутствия CallKit. Оставлены безопасные режимы: `audio`, `fetch`, `remote-notification`.
2. **Guideline 2.1 (App Completeness)**:
   - В App Review Information подготовлены тестовые корпоративные учетные данные и преднастроенный сервер.

---

## 3. Google Play Policies & Android Audit

### 3.1. Аудит Edge-to-Edge и поддержка Android 15 (Target SDK 35)

- `compileSdk = 35`, `targetSdk = 35`.
- В `MainActivity.kt` вызывается `enableEdgeToEdge()`.
- Режим `windowSoftInputMode="adjustResize"` обеспечивает корректную анимацию клавиатуры.
- Отступы `Scaffold` и `.imePadding()` протестированы.

### 3.2. Аудит Runtime Permissions (Разрешения во время выполнения)

| Разрешение | Заявлено в манифесте | Запрос во время выполнения (Runtime) | Оценка готовности |
|---|:---:|:---:|:---:|
| `android.permission.RECORD_AUDIO` | ✅ | ✅ Запрашивается в `CallScreen.kt` через `rememberLauncherForActivityResult` | ✅ ГОТОВО |
| `android.permission.POST_NOTIFICATIONS` | ✅ | ✅ Запрашивается в `MainActivity.kt` для Android 13+ (API 33+) | ✅ ГОТОВО |
| `android.permission.VIBRATE` | ✅ | Не требуется (Normal permission) | ✅ ГОТОВО |
| `android.permission.INTERNET` | ✅ | Не требуется (Normal permission) | ✅ ГОТОВО |
| `android.permission.ACCESS_NETWORK_STATE` | ✅ | Не требуется (Normal permission) | ✅ ГОТОВО |
| `android.permission.MODIFY_AUDIO_SETTINGS` | ✅ | Не требуется (Normal permission) | ✅ ГОТОВО |

---

## 4. Заключение

Все требования App Store Review Guidelines и Google Play Developer Program Policies полностью выполнены. Приложения допущены к релизу.
