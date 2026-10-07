import Foundation
import XCTest
@testable import CentyChat

/// The shared Russian copy (`mobile/contracts/copy/ru.json`, keys of `copy-ru.md`): every state
/// iOS shows that the table names uses the canonical text — the same check Android's `CopyRuTest`
/// makes, the way the reducer vectors are shared.
final class CopyRuTests: XCTestCase {
    private let canonical: [String: Any] = {
        // The contract folder next to the sources (the simulator reads the checkout), or the copy
        // a Linux run places next to the tests.
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let candidates = [
            tests.appendingPathComponent("../../contracts/copy/ru.json").standardizedFileURL,
            tests.appendingPathComponent("copy/ru.json"),
        ]
        for url in candidates {
            if let data = try? Data(contentsOf: url),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return object
            }
        }
        return [:]
    }()

    private func text(_ key: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        guard let value = canonical[key] as? String else {
            XCTFail("ru.json has no text \(key)", file: file, line: line)
            return "<\(key)>"
        }
        return value
    }

    private func plural(_ key: String, _ category: String) -> String {
        ((canonical[key] as? [String: Any])?[category] as? String) ?? "<\(key).\(category)>"
    }

    private let now = Date(timeIntervalSince1970: 1_000)

    func testTheContractTableIsReadable() {
        XCTAssertGreaterThan(canonical.count, 80, "mobile/contracts/copy/ru.json was not found")
    }

    func testFixedTextsAreTheCanonicalOnes() {
        let pairs: [(String, String)] = [
            ("signout.title", AppCopy.signOutTitle),
            ("signout.body", AppCopy.signOutBody),
            ("signout.unsent_unknown", AppCopy.signOutUnsentUnknown),
            ("signout.confirm", AppCopy.signOutConfirm),
            ("signout.failed_unsent", AppCopy.signOutFailedUnsent),
            ("delivery.failed", AppCopy.deliveryFailed),
            ("delivery.retry", AppCopy.deliveryRetry),
            ("delivery.discard", AppCopy.deliveryDiscard),
            ("block.confirm.title", AppCopy.blockTitle),
            ("block.confirm.action", AppCopy.blockAction),
            ("block.done", AppCopy.blockDone),
            ("unblock.action", AppCopy.unblockAction),
            ("unblock.done", AppCopy.unblockDone),
            ("unblock.failed", AppCopy.unblockFailed),
            ("chat.blocked_by_me.banner", AppCopy.blockedByMeBanner),
            ("blocked.list.title", AppCopy.blockedListTitle),
            ("blocked.list.empty", AppCopy.blockedListEmpty),
            ("blocked.list.empty_hint", AppCopy.blockedListEmptyHint),
            ("blocked.list.footer", AppCopy.blockedListFooter),
            ("blocked.list.load_failed", AppCopy.blockedListLoadFailed),
            ("delete.warning", AppCopy.deleteWarning),
            ("delete.confirm.title", AppCopy.deleteConfirmTitle),
            ("delete.confirm.body", AppCopy.deleteConfirmBody),
            ("chat.dm_not_allowed.banner", AppCopy.dmNotAllowedBanner),
            ("chat.composer.locked_placeholder", AppCopy.composerLockedPlaceholder),
            ("chat.empty.locked", AppCopy.chatEmptyLocked),
            ("reg.pending.title", AppCopy.regPendingTitle),
            ("reg.pending.body", AppCopy.regPendingBody),
            ("conn.offline", AppCopy.connOffline),
            ("conn.reconnecting", AppCopy.connReconnecting),
            ("conn.back_online", AppCopy.connBackOnline),
            ("conn.signed_out", AppCopy.connSignedOut),
            ("upload.failed_badge", AppCopy.uploadFailedBadge),
            ("upload.cannot_prepare", AppCopy.uploadCannotPrepare),
        ]
        for (key, actual) in pairs {
            XCTAssertEqual(actual, text(key), key)
        }
        XCTAssertEqual(AppCopy.blockBody(name: "Боб Тестов"), text("block.confirm.body").replacingOccurrences(of: "{name}", with: "Боб Тестов"))
        XCTAssertEqual(AppCopy.deliveryFailed(reason: "сервер не ответил"), text("delivery.failed_with_reason").replacingOccurrences(of: "{reason}", with: "сервер не ответил"))
    }

    // MARK: - Sign-out (§1)

    func testTheSignOutQuestionUsesTheCanonicalLines() {
        for (count, category) in [(1, "one"), (21, "one"), (3, "few"), (24, "few"), (5, "many"), (11, "many"), (112, "many")] {
            XCTAssertEqual(UnsentNotice.text(count), plural("signout.unsent", category).replacingOccurrences(of: "{count}", with: "\(count)"), "\(count)")
        }
        XCTAssertEqual(UnsentNotice.text(nil), text("signout.unsent_unknown"))
        XCTAssertNil(UnsentNotice.text(0))

        // Always asked (final review M3): the unsent line first, a blank line, then the body.
        XCTAssertEqual(SignOutPrompt.message(unsent: 0), text("signout.body"))
        XCTAssertEqual(SignOutPrompt.message(unsent: 2), UnsentNotice.text(2)! + "\n\n" + text("signout.body"))
        XCTAssertEqual(SignOutPrompt.message(unsent: nil), text("signout.unsent_unknown") + "\n\n" + text("signout.body"))
    }

    // MARK: - Delivery (§2)

    func testDeliveryNoticesUseTheCanonicalTexts() {
        for code in ["EMPTY_TEXT", "TEXT_TOO_LONG", "NOT_EDITABLE", "EDIT_REJECTED", "NOT_DELETABLE", "DELETE_REJECTED", "DELETE_NOT_CONFIRMED", "DM_NOT_ALLOWED"] {
            XCTAssertEqual(DeliveryNotices.text(code), text("delivery.\(code)"), code)
        }
        for code in ["INVALID_CLIENT_MSG_ID", "INVALID_CONVERSATION", "INVALID_MESSAGE_TYPE"] {
            XCTAssertEqual(DeliveryNotices.text(code), text("delivery.INVALID_KEY"), code)
        }
        XCTAssertEqual(DeliveryNotices.text("SOMETHING_NEW"), text("delivery.NOT_SAVED"))
        XCTAssertEqual(DeliveryNotices.notSaved, text("delivery.NOT_SAVED"))
    }

    func testTheReasonOfAFailedMessageIsCanonical() async {
        let noAnswer = await ChatProjection.failureText(DeliveryFailure(reason: DeliveryFailure.maxAttempts, code: nil, message: nil))
        let refused = await ChatProjection.failureText(DeliveryFailure(reason: DeliveryFailure.rejected, code: "X", message: nil))
        let ownWords = await ChatProjection.failureText(DeliveryFailure(reason: DeliveryFailure.rejected, code: "X", message: "Текст сервера"))
        XCTAssertEqual(noAnswer, text("delivery.reason.max_attempts"))
        XCTAssertEqual(refused, text("delivery.reason.rejected"))
        XCTAssertEqual(ownWords, "Текст сервера")
    }

    // MARK: - Block and deletion (§3)

    func testAccountDeletionRefusalsAreCanonical() {
        XCTAssertEqual(AccountFailure.wrongPassword.message(at: now), text("delete.wrong_password"))
        XCTAssertEqual(AccountFailure.lastAdmin.message(at: now), text("delete.last_admin"))
    }

    // MARK: - Registration (§5) and login (§6)

    func testRegistrationTextsAreCanonical() {
        XCTAssertEqual(AccountFailure.registrationDisabled.message(at: now), text("reg.disabled"))
        XCTAssertEqual(AccountFailure.serverBusy(until: now.addingTimeInterval(45)).message(at: now), text("reg.busy").replacingOccurrences(of: "{wait}", with: "45 с"))
        XCTAssertEqual(AccountFailure.throttled(until: now.addingTimeInterval(600)).message(at: now), text("reg.throttled").replacingOccurrences(of: "{wait}", with: "10 мин"))
        XCTAssertEqual(AccountFailure.mailNotConfigured.message(at: now), text("reg.mail_not_configured"))
        XCTAssertEqual(AccountFailure.mailSendFailed.message(at: now), text("reg.mail_send_failed"))
        XCTAssertEqual(AccountFailure.conflictText(code: "USERNAME_TAKEN", message: "x"), text("reg.username_taken"))
        XCTAssertEqual(AccountFailure.conflictText(code: "EMAIL_TAKEN", message: "x"), text("reg.email_taken"))
        XCTAssertEqual(AccountFailure.conflict("").message(at: now), text("reg.conflict"))
        XCTAssertEqual(AccountFailure.invalidInput("").message(at: now), text("reg.invalid_input"))
        XCTAssertEqual(AccountFailure.wrongCode("", attemptsLeft: nil).message(at: now), text("reg.wrong_code"))
        XCTAssertEqual(
            AccountFailure.wrongCode("", attemptsLeft: 2).message(at: now),
            text("reg.attempts_left").replacingOccurrences(of: "{text}", with: text("reg.wrong_code")).replacingOccurrences(of: "{count}", with: "2")
        )
        XCTAssertEqual(AccountFailure.codeExpired.message(at: now), text("reg.code_expired"))
        XCTAssertEqual(AccountFailure.codeExpiredLocally.message(at: now), text("reg.code_expired_local"))
        XCTAssertEqual(AccountFailure.offline.message(at: now), text("reg.offline"))
        XCTAssertEqual(AccountFailure.unavailable.message(at: now), text("reg.unavailable"))
        XCTAssertEqual(AccountFailure.storage.message(at: now), text("reg.storage"))
        XCTAssertEqual(AccountFailure(KeychainManagerError.addFailed(status: -1), context: .registrationVerify, now: now), .storage)
    }

    func testLoginTextsAreCanonical() {
        XCTAssertEqual(LoginFailure.invalidCredentials.message(at: now), text("login.invalid"))
        XCTAssertEqual(LoginFailure.serverBusy(until: now.addingTimeInterval(150)).message(at: now), text("login.busy").replacingOccurrences(of: "{wait}", with: "2 мин 30 с"))
        XCTAssertEqual(LoginFailure.accountPending.message(at: now), text("login.pending.body"))
        XCTAssertEqual(LoginFailure.accountRejected.message(at: now), text("login.rejected.body"))
        XCTAssertEqual(LoginFailure.offline.message(at: now), text("login.offline"))
    }

    /// `{wait}`: «45 с» under a minute, otherwise «2 мин 30 с», or «10 мин» when the seconds are 0.
    func testWaitsReadTheSameEverywhere() {
        XCTAssertEqual(AppCopy.wait(seconds: 45), "45 с")
        XCTAssertEqual(AppCopy.wait(seconds: 150), "2 мин 30 с")
        XCTAssertEqual(AppCopy.wait(seconds: 600), "10 мин")
    }

    // MARK: - Attachments (§8)

    func testAttachmentTextsAreCanonical() {
        let policy = FilePolicyEffectiveResponse(enabled: true, allowed: ["pdf"])
        XCTAssertEqual(AttachmentRules.problem(name: "a.pdf", size: 0, policy: nil), text("upload.empty"))
        XCTAssertEqual(AttachmentRules.problem(name: "a.pdf", size: AttachmentRules.maxBytes + 1, policy: nil), text("upload.too_big"))
        XCTAssertEqual(AttachmentRules.problem(name: "README", size: 10, policy: policy), text("upload.no_extension"))
        XCTAssertEqual(AttachmentRules.problem(name: "setup.exe", size: 10, policy: policy), text("upload.ext_not_allowed").replacingOccurrences(of: "{ext}", with: "exe"))
        XCTAssertEqual(AttachmentRules.refused, text("upload.refused"))
        XCTAssertEqual(AttachmentRules.noNetwork, text("upload.no_network"))
        XCTAssertEqual(AttachmentDownloader.noNetwork, text("download.no_network"))
        XCTAssertEqual(AttachmentDownloader.interrupted, text("download.interrupted"))
        XCTAssertEqual(AttachmentDownloader.refusalText(status: 403, errorText: nil), text("download.forbidden"))
        XCTAssertEqual(AttachmentDownloader.refusalText(status: 404, errorText: nil), text("download.not_found"))
        XCTAssertEqual(AttachmentDownloader.refusalText(status: 500, errorText: nil), text("download.failed"), "an HTTP code means nothing to an employee")
    }
}
