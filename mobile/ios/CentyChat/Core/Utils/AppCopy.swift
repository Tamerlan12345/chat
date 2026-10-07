import Foundation

/// The canonical Russian texts shared by all three clients (`mobile/contracts/copy-ru.md`, machine
/// form `mobile/contracts/copy/ru.json`). Each constant names its key; `CopyRuTests` checks every
/// one against the JSON, so a text changes in the contract first.
enum AppCopy {
    // MARK: - Sign-out (§1)

    static let signOutTitle = String(localized: "Выйти из учётной записи?") // signout.title
    static let signOutBody = String(localized: "Чтобы снова войти на этом устройстве, понадобятся логин и пароль.") // signout.body
    static let signOutUnsentUnknown = String(localized: "Не удалось проверить неотправленные сообщения. Если они есть, они будут удалены.") // signout.unsent_unknown
    static let signOutConfirm = String(localized: "Выйти") // signout.confirm
    static let signOutFailedUnsent = String(localized: "Не удалось удалить неотправленные сообщения. Выход отменён.") // signout.failed_unsent

    /// `signout.unsent` (plural): «{count} неотправленное сообщение будет удалено.» …
    static func signOutUnsent(_ count: Int) -> String {
        RussianPlural.form(
            count,
            one: String(localized: "\(count) неотправленное сообщение будет удалено."),
            few: String(localized: "\(count) неотправленных сообщения будут удалены."),
            many: String(localized: "\(count) неотправленных сообщений будут удалены.")
        )
    }

    // MARK: - Delivery (§2)

    static let deliveryEmptyText = String(localized: "Нельзя отправить пустое сообщение") // delivery.EMPTY_TEXT
    static let deliveryTextTooLong = String(localized: "Сообщение длиннее 16 000 символов") // delivery.TEXT_TOO_LONG
    static let deliveryNotEditable = String(localized: "Это сообщение нельзя изменить") // delivery.NOT_EDITABLE
    static let deliveryEditRejected = String(localized: "Изменение не сохранено: сообщение больше нельзя изменить") // delivery.EDIT_REJECTED
    static let deliveryNotDeletable = String(localized: "Это сообщение нельзя удалить") // delivery.NOT_DELETABLE
    static let deliveryDeleteRejected = String(localized: "Сообщение не удалено: время на удаление истекло") // delivery.DELETE_REJECTED
    static let deliveryDeleteNotConfirmed = String(localized: "Сервер не подтвердил удаление — сообщение снова показано") // delivery.DELETE_NOT_CONFIRMED
    static let deliveryInvalidKey = String(localized: "Не удалось подготовить сообщение к отправке") // delivery.INVALID_KEY
    static let deliveryNotSaved = String(localized: "Сообщение не сохранено — попробуйте ещё раз") // delivery.NOT_SAVED
    static let deliveryDMNotAllowed = String(localized: "Сообщение не может быть доставлено") // delivery.DM_NOT_ALLOWED
    static let deliveryFailed = String(localized: "Не отправлено") // delivery.failed
    static func deliveryFailed(reason: String) -> String { String(localized: "Не отправлено: \(reason)") } // delivery.failed_with_reason
    static let deliveryReasonNoAnswer = String(localized: "сервер не ответил") // delivery.reason.max_attempts
    static let deliveryReasonRejected = String(localized: "сервер не принял сообщение") // delivery.reason.rejected
    static let deliveryRetry = String(localized: "Повторить") // delivery.retry
    static let deliveryDiscard = String(localized: "Удалить") // delivery.discard

    // MARK: - Block, unblock, account deletion (§3)

    static let blockTitle = String(localized: "Заблокировать пользователя?") // block.confirm.title
    static func blockBody(name: String) -> String { // block.confirm.body
        String(localized: "\(name) не сможет писать вам, а вы — ему. Его личные сообщения будут скрыты. В каналах ничего не изменится. Разблокировать можно в чате или в профиле.")
    }
    static let blockAction = String(localized: "Заблокировать") // block.confirm.action
    static let blockDone = String(localized: "Пользователь заблокирован") // block.done
    static let unblockAction = String(localized: "Разблокировать") // unblock.action
    static let unblockDone = String(localized: "Пользователь разблокирован. Скрытые сообщения снова видны.") // unblock.done
    static let unblockFailed = String(localized: "Не удалось разблокировать. Повторите попытку.") // unblock.failed
    static let blockedByMeBanner = String(localized: "Вы заблокировали этого пользователя. Пока блокировка действует, писать друг другу нельзя.") // chat.blocked_by_me.banner
    static let blockedListTitle = String(localized: "Заблокированные") // blocked.list.title
    static let blockedListEmpty = String(localized: "Вы никого не блокировали") // blocked.list.empty
    static let blockedListEmptyHint = String(localized: "Заблокировать человека можно в его карточке или в меню личной переписки.") // blocked.list.empty_hint
    static let blockedListFooter = String(localized: "Вы не можете писать друг другу, пока блокировка не снята.") // blocked.list.footer
    static let blockedListLoadFailed = String(localized: "Не удалось загрузить список заблокированных") // blocked.list.load_failed
    static let deleteWarning = String(localized: "Учётная запись и личные данные (имя, почта, телефон, фото) будут удалены безвозвратно. Отправленные сообщения останутся у собеседников с подписью «Удалённый сотрудник». Восстановить учётную запись нельзя.") // delete.warning
    static let deleteConfirmTitle = String(localized: "Удалить учётную запись навсегда?") // delete.confirm.title
    static let deleteConfirmBody = String(localized: "Это действие нельзя отменить.") // delete.confirm.body
    static let deleteWrongPassword = String(localized: "Неверный пароль.") // delete.wrong_password
    static let deleteLastAdmin = String(localized: "Вы — единственный администратор. Назначьте другого администратора, затем удалите учётную запись.") // delete.last_admin

    // MARK: - DM_NOT_ALLOWED and the composer lock (§4)

    static let dmNotAllowedBanner = String(localized: "Сообщение не может быть доставлено. Писать в эту переписку сейчас нельзя.") // chat.dm_not_allowed.banner
    static let composerLockedPlaceholder = String(localized: "Отправка недоступна") // chat.composer.locked_placeholder
    static let chatEmptyLocked = String(localized: "Сообщений нет") // chat.empty.locked

    // MARK: - Registration (§5)

    static let regDisabled = String(localized: "Регистрация сейчас закрыта. Обратитесь к администратору.") // reg.disabled
    static func regBusy(wait: String) -> String { String(localized: "Сервер сейчас занят. Повторите через \(wait).") } // reg.busy
    static func regThrottled(wait: String) -> String { String(localized: "Слишком много попыток. Повторите через \(wait).") } // reg.throttled
    static let regMailNotConfigured = String(localized: "Сервер не может отправить письмо с кодом: почта не настроена. Регистрация временно недоступна — обратитесь к администратору.") // reg.mail_not_configured
    static let regMailSendFailed = String(localized: "Не удалось отправить письмо с кодом. Повторите попытку позже.") // reg.mail_send_failed
    static let regUsernameTaken = String(localized: "Этот логин уже занят. Выберите другой.") // reg.username_taken
    static let regEmailTaken = String(localized: "На этот адрес почты уже подана заявка или есть учётная запись.") // reg.email_taken
    static let regConflict = String(localized: "Такой логин или адрес почты уже зарегистрирован.") // reg.conflict
    static let regInvalidInput = String(localized: "Проверьте введённые данные.") // reg.invalid_input
    static let regWrongCode = String(localized: "Неверный код. Проверьте письмо и попробуйте ещё раз.") // reg.wrong_code
    static func regAttemptsLeft(text: String, count: Int) -> String { String(localized: "\(text) Осталось попыток: \(count).") } // reg.attempts_left
    static let regCodeExpired = String(localized: "Код больше не действует: срок истёк, он уже использован или попытки закончились. Запросите новый код.") // reg.code_expired
    static let regCodeExpiredLocal = String(localized: "Срок действия кода истёк. Запросите новый код.") // reg.code_expired_local
    static let regOffline = String(localized: "Нет связи с сервером. Проверьте подключение к интернету.") // reg.offline
    static let regUnavailable = String(localized: "Не удалось выполнить действие. Повторите попытку позже.") // reg.unavailable
    static let regStorage = String(localized: "Защищённое хранилище устройства недоступно. Разблокируйте устройство и повторите попытку.") // reg.storage
    static let regPendingTitle = String(localized: "Заявка на рассмотрении") // reg.pending.title
    static let regPendingBody = String(localized: "Почта подтверждена. Вход станет доступен после одобрения заявки администратором. Срок рассмотрения заранее неизвестен.") // reg.pending.body

    // MARK: - Login (§6)

    static let loginPendingBody = String(localized: "Заявка на регистрацию ещё рассматривается администратором. Вход откроется после одобрения.") // login.pending.body
    static let loginRejectedBody = String(localized: "Заявка на регистрацию отклонена администратором. Обратитесь к администратору вашей компании.") // login.rejected.body
    static func loginBusy(wait: String) -> String { String(localized: "Сервер сейчас занят. Повторите через \(wait).") } // login.busy
    static let loginInvalid = String(localized: "Неверный логин или пароль") // login.invalid
    static let loginOffline = String(localized: "Нет связи с сервером. Проверьте подключение к интернету.") // login.offline

    // MARK: - Connection (§7)

    static let connOffline = String(localized: "Нет сети") // conn.offline
    static let connReconnecting = String(localized: "Переподключение…") // conn.reconnecting
    static let connBackOnline = String(localized: "Снова в сети") // conn.back_online
    static let connSignedOut = String(localized: "Сеанс завершён. Войдите снова.") // conn.signed_out

    // MARK: - Attachments (§8)

    static let uploadTooBig = String(localized: "Файл больше 100 МБ — такой файл загрузить нельзя") // upload.too_big
    static let uploadEmpty = String(localized: "Файл пустой") // upload.empty
    static let uploadNoExtension = String(localized: "У файла нет расширения") // upload.no_extension
    static func uploadExtensionNotAllowed(_ ext: String) -> String { String(localized: "Файлы .\(ext) к отправке не разрешены") } // upload.ext_not_allowed
    static let uploadRefused = String(localized: "Сервер не принял файл") // upload.refused
    static let uploadNoNetwork = String(localized: "Нет связи с сервером — файл отправится, когда связь вернётся") // upload.no_network
    static let uploadFailedBadge = String(localized: "Не загрузилось") // upload.failed_badge
    static let uploadCannotPrepare = String(localized: "Не удалось подготовить файл к отправке") // upload.cannot_prepare
    static let downloadNoNetwork = String(localized: "Нет связи с сервером — файл не скачан") // download.no_network
    static let downloadInterrupted = String(localized: "Связь прервалась. Нажмите ещё раз — загрузка продолжится.") // download.interrupted
    static let downloadForbidden = String(localized: "Нет доступа к файлу") // download.forbidden
    static let downloadNotFound = String(localized: "Файл не найден") // download.not_found
    static let downloadFailed = String(localized: "Не удалось скачать файл") // download.failed

    // MARK: - `{wait}`

    /// The same on every client: «45 с» under a minute, otherwise «2 мин 30 с», or «10 мин».
    static func wait(seconds total: Int) -> String {
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 { return String(localized: "\(seconds) с") }
        if seconds == 0 { return String(localized: "\(minutes) мин") }
        return String(localized: "\(minutes) мин \(seconds) с")
    }
}
