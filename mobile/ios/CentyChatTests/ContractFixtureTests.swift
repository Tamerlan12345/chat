import Foundation
import XCTest
@testable import CentyChat

/// Decodes every fixture listed in `mobile/contracts/fixtures/manifest.json` (bundled into
/// this test target as a folder reference, not copied) into the app's DTOs and WebSocket
/// events. A new fixture without a decoder, or a fixture the app cannot decode, fails.
final class ContractFixtureTests: XCTestCase {
    private struct ManifestEntry: Decodable {
        let kind: String
        let event: String?
        let status: Int?
        let provider: String?
    }

    private func fixturesRoot() throws -> URL {
        let bundle = Bundle(for: ContractFixtureTests.self)
        return try XCTUnwrap(
            bundle.url(forResource: "fixtures", withExtension: nil),
            "mobile/contracts/fixtures must be bundled into CentyChatTests as a folder reference"
        )
    }

    private func manifest() throws -> [String: ManifestEntry] {
        let data = try Data(contentsOf: fixturesRoot().appendingPathComponent("manifest.json"))
        return try JSONDecoder().decode([String: ManifestEntry].self, from: data)
    }

    func testEveryManifestFixtureDecodes() throws {
        let root = try fixturesRoot()
        let entries = try manifest()
        XCTAssertGreaterThanOrEqual(entries.count, 100, "The manifest looks truncated (104 entries on 2026-10-03)")

        for (file, entry) in entries.sorted(by: { $0.key < $1.key }) {
            let data: Data
            do {
                data = try Data(contentsOf: root.appendingPathComponent(file))
            } catch {
                XCTFail("\(file): listed in the manifest but missing (\(error))")
                continue
            }
            switch entry.kind {
            case "http":
                do {
                    try decodeHTTPFixture(named: file, data)
                } catch {
                    XCTFail("\(file): does not decode: \(error)")
                }
            case "ws":
                assertEventParses(file, expectedType: entry.event, data)
            case "push":
                assertPushParses(file, provider: entry.provider, data)
            default:
                XCTFail("\(file): unknown fixture kind \(entry.kind)")
            }
        }
    }

    func testEveryFixtureFileIsListedInTheManifest() throws {
        let root = try fixturesRoot()
        let listed = Set(try manifest().keys)
        for folder in ["http", "ws", "push"] {
            let files = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(folder).path)
            for file in files where file.hasSuffix(".json") {
                XCTAssertTrue(listed.contains("\(folder)/\(file)"), "\(folder)/\(file) is not in manifest.json")
            }
        }
    }

    // MARK: - HTTP

    private func decodeHTTPFixture(named file: String, _ data: Data) throws {
        let name = file.replacingOccurrences(of: "http/", with: "").replacingOccurrences(of: ".json", with: "")
        let decoder = JSONDecoder()
        switch name {
        case "announcements.list":
            XCTAssertFalse(try decoder.decode([Announcement].self, from: data).isEmpty, file)
        case "auth.device-claim":
            XCTAssertTrue(try decoder.decode(DeviceClaimResponse.self, from: data).claimed, file)
        case "auth.knock-login-required":
            XCTAssertEqual(try decoder.decode(KnockResponse.self, from: data).status, .loginRequired, file)
        case "auth.knock-paired":
            let response = try decoder.decode(KnockResponse.self, from: data)
            XCTAssertEqual(response.status, .paired, file)
            XCTAssertNotNil(response.token, file)
            XCTAssertNotNil(response.user, file)
        case "auth.knock-pending":
            XCTAssertEqual(try decoder.decode(KnockResponse.self, from: data).status, .pending, file)
        case "auth.login":
            let response = try decoder.decode(AuthSuccessResponse.self, from: data)
            XCTAssertFalse(response.token.isEmpty, file)
            XCTAssertFalse(response.user.mustChangePassword, file)
        case "auth.login-error", "auth.unauthorized":
            XCTAssertFalse(try decoder.decode(ServerErrorResponse.self, from: data).error.isEmpty, file)
        case "auth.logout":
            XCTAssertTrue(try decoder.decode(SuccessResponse.self, from: data).success, file)
        case "auth.me":
            XCTAssertFalse(try decoder.decode(CurrentUserResponse.self, from: data).user.username.isEmpty, file)
        case "auth.refresh":
            XCTAssertFalse(try decoder.decode(RefreshTokenResponse.self, from: data).token.isEmpty, file)
        case "channels.list":
            XCTAssertFalse(try decoder.decode([Channel].self, from: data).isEmpty, file)
        case "conversations.direct":
            XCTAssertFalse(try decoder.decode([DirectConversation].self, from: data).isEmpty, file)
        case "files.policy":
            XCTAssertTrue(try decoder.decode(FilePolicyEffectiveResponse.self, from: data).isExtensionAllowed("pdf"), file)
        case "files.upload":
            XCTAssertFalse(try decoder.decode(FileUploadResponse.self, from: data).url.isEmpty, file)
        case "files.upload-image":
            let upload = try decoder.decode(FileUploadResponse.self, from: data)
            XCTAssertEqual(upload.width, 640, file)
            XCTAssertEqual(upload.height, 480, file)
            XCTAssertEqual(upload.dominantColor, "#c83838", file)
        case "devices.push-token-register":
            let response = try decoder.decode(PushTokenRegisterResponse.self, from: data)
            XCTAssertTrue(response.registered, file)
            XCTAssertFalse(response.pushEnabled, file)
        case "devices.push-token-delete":
            XCTAssertTrue(try decoder.decode(PushTokenDeleteResponse.self, from: data).removed, file)
        case "devices.push-token-invalid":
            XCTAssertEqual(try decoder.decode(ServerErrorResponse.self, from: data).code, "INVALID_ENVIRONMENT", file)
        case "messages.send-cancelled":
            XCTAssertEqual(try decoder.decode(ServerErrorResponse.self, from: data).code, "CANCELLED", file)
        case "users.avatar-not-image":
            XCTAssertEqual(try decoder.decode(ServerErrorResponse.self, from: data).code, "NOT_AN_IMAGE", file)
        case "users.avatar-upload":
            let user = try decoder.decode(User.self, from: data)
            XCTAssertTrue(user.avatarUrl?.hasPrefix("/api/users/4/avatar?v=") == true, file)
        case "users.get-with-avatar":
            let user = try decoder.decode(PublicUser.self, from: data)
            XCTAssertTrue(user.avatarUrl?.hasPrefix("/api/users/4/avatar?v=") == true, file)
        case "messages.after-page", "messages.channel-page", "messages.direct-page":
            XCTAssertFalse(try decoder.decode([Message].self, from: data).isEmpty, file)
        case "messages.send-direct", "messages.send-direct-duplicate", "messages.send-direct-idempotent":
            XCTAssertGreaterThan(try decoder.decode(Message.self, from: data).id, 0, file)
        case "messages.send-client-msg-id-conflict":
            XCTAssertEqual(try decoder.decode(ServerErrorResponse.self, from: data).code, "CLIENT_MSG_ID_CONFLICT", file)
        case "messages.send-client-msg-id-invalid":
            XCTAssertEqual(try decoder.decode(ServerErrorResponse.self, from: data).code, "INVALID_CLIENT_MSG_ID", file)
        case "sync.bootstrap", "sync.page":
            XCTAssertFalse(try decoder.decode(SyncResponse.self, from: data).nextCursor.isEmpty, file)
        case "sync.cursor-invalid":
            XCTAssertEqual(try decoder.decode(ServerErrorResponse.self, from: data).code, "SYNC_CURSOR_INVALID", file)
        case "users.get":
            XCTAssertFalse(try decoder.decode(PublicUser.self, from: data).fullName.isEmpty, file)
        case "users.list":
            XCTAssertFalse(try decoder.decode([PublicUser].self, from: data).isEmpty, file)
        // Registration (decision Q): the switch and every refusal the screens branch on.
        case "auth.register-request-disabled":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertEqual(error.code, "REGISTRATION_DISABLED", file)
            XCTAssertEqual(accountFailure(403, error, .registrationRequest), .registrationDisabled, file)
        case "auth.register-verify-disabled":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertEqual(error.code, "REGISTRATION_DISABLED", file)
            XCTAssertEqual(accountFailure(403, error, .registrationVerify), .registrationDisabled, file)
        case "auth.register-request-invalid":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertNil(error.code, file)
            XCTAssertEqual(accountFailure(400, error, .registrationRequest), .invalidInput(error.error), file)
        case "auth.register-request-mail-not-configured":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertEqual(error.code, "EMAIL_NOT_CONFIGURED", file)
            XCTAssertEqual(accountFailure(503, error, .registrationRequest), .mailNotConfigured, file)
        case "auth.register-verify-expired":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertEqual(error.code, "CODE_EXPIRED", file)
            XCTAssertEqual(accountFailure(410, error, .registrationVerify), .codeExpired, file)
        case "auth.register-verify-invalid":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertEqual(error.code, "CODE_INVALID", file)
            XCTAssertNil(error.attemptsLeft, "a malformed code has no attemptsLeft: \(file)")
            XCTAssertEqual(accountFailure(400, error, .registrationVerify), .wrongCode(error.error, attemptsLeft: nil), file)
        // Blocks and reports.
        case "blocks.add":
            XCTAssertEqual(try decoder.decode(BlockedUser.self, from: data).id, 3, file)
        case "blocks.list":
            let blocked = try decoder.decode(BlockListResponse.self, from: data).blocked
            XCTAssertEqual(blocked.map(\.id), [3], file)
            XCTAssertEqual(blocked.first?.name, "Боб Тестов", file)
        case "blocks.remove", "users.delete-me":
            XCTAssertTrue(try decoder.decode(SuccessResponse.self, from: data).success, file)
        case "reports.create":
            let report = try decoder.decode(ReportCreatedResponse.self, from: data)
            XCTAssertGreaterThan(report.id, 0, file)
            XCTAssertEqual(report.status, "open", file)
        case "users.delete-me-wrong-password":
            let error = try decoder.decode(ServerErrorResponse.self, from: data)
            XCTAssertEqual(error.code, "INVALID_PASSWORD", file)
            XCTAssertEqual(accountFailure(400, error, .deleteAccount), .wrongPassword, file)
        // The login screen shows «Зарегистрироваться» only while the server takes registrations.
        case "settings.info":
            let info = try decoder.decode(ServerInfo.self, from: data)
            XCTAssertTrue(info.allowRegistration, file)
            XCTAssertFalse(info.serverName.isEmpty, file)
        default:
            XCTFail("\(file): no DTO is mapped to this fixture; add one before the contract can ship")
        }
    }

    /// What the account screens make of a fixture's refusal, as `APIClient` reports it.
    private func accountFailure(_ status: Int, _ error: ServerErrorResponse, _ context: AccountFailure.Context) -> AccountFailure {
        let api: APIError = if let attemptsLeft = error.attemptsLeft {
            .rejectedWithAttempts(statusCode: status, message: error.error, code: error.code, attemptsLeft: attemptsLeft)
        } else {
            .httpError(statusCode: status, message: error.error, code: error.code)
        }
        return AccountFailure(api, context: context, now: Date(timeIntervalSince1970: 1_000))
    }

    // MARK: - Push

    /// `push/fcm.*`: the device receives `message.data` (string values); `push/apns.*`: the
    /// `payload` is `userInfo` (numeric ids). Both must parse into the matching `PushPayload`.
    private func assertPushParses(_ file: String, provider: String?, _ data: Data) {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return XCTFail("\(file): not a JSON object")
        }
        let userInfo: [String: Any]?
        switch provider {
        case "fcm": userInfo = (root["message"] as? [String: Any])?["data"] as? [String: Any]
        case "apns": userInfo = root["payload"] as? [String: Any]
        default: return XCTFail("\(file): unknown push provider \(provider ?? "nil")")
        }
        guard let userInfo else { return XCTFail("\(file): no data/payload object") }
        guard let payload = PushPayload.parse(userInfo) else {
            return XCTFail("\(file): PushPayload.parse returned nil")
        }
        let kind = file.split(separator: ".").dropFirst().first.map(String.init) ?? ""
        switch (kind, payload) {
        case ("message", .message(let conversation, let messageId)):
            XCTAssertGreaterThan(messageId, 0, file)
            XCTAssertGreaterThan(conversation.targetId, 0, file)
            XCTAssertEqual(conversation.type == .channel, file.contains(".channel"), file)
        case ("read", .read(let conversation)):
            XCTAssertGreaterThan(conversation.targetId, 0, file)
        case ("call", .call(let callerId, _)):
            XCTAssertEqual(callerId, 2, file)
        default:
            XCTFail("\(file): parsed as \(payload)")
        }
    }

    // MARK: - WebSocket

    private func assertEventParses(_ file: String, expectedType: String?, _ data: Data) {
        guard let event = WSServerEvent.parse(from: data) else {
            return XCTFail("\(file): WSServerEvent.parse returned nil")
        }
        if case .unknown(let type, _) = event {
            return XCTFail("\(file): parsed as unknown event \(type)")
        }
        guard let expectedType else {
            return XCTFail("\(file): manifest entry has no event type")
        }
        XCTAssertTrue(
            Self.wireTypes(of: event).contains(expectedType),
            "\(file): \(expectedType) parsed as \(event)"
        )
    }

    /// Wire `type` values each parsed case may come from.
    private static func wireTypes(of event: WSServerEvent) -> Set<String> {
        switch event {
        case .authSuccess: ["auth_success"]
        case .authError: ["auth_error"]
        case .wakeState: ["wake_state"]
        case .serverDisconnect: ["server_disconnect"]
        case .newMessage: ["new_message", "direct_message", "channel_message"]
        case .conversationRead: ["conversation_read"]
        case .messageCancelled: ["message_cancelled"]
        case .messageStatusUpdated: ["message_status_updated"]
        case .messagesRead: ["messages_read"]
        case .messageUpdated: ["message_updated"]
        case .messageDeleted: ["message_deleted"]
        case .userTyping: ["user_typing"]
        case .userStatusChanged: ["user_status_changed"]
        case .userCreated: ["user_created"]
        case .userUpdated: ["user_updated"]
        case .channelCreated: ["channel_created"]
        case .channelDeleted: ["channel_deleted"]
        case .newAnnouncement: ["new_announcement"]
        case .announcementAcknowledged: ["announcement_acknowledged"]
        case .callOffer: ["call_offer"]
        case .callAnswer: ["call_answer"]
        case .callRejected: ["call_rejected"]
        case .callEnd: ["call_end"]
        case .callDenied: ["call_denied"]
        case .callUnavailable: ["call_unavailable"]
        case .iceCandidate: ["ice_candidate"]
        case .wakeRing: ["wake_ring"]
        case .wakeSent: ["wake_sent"]
        case .wakeError: ["wake_error"]
        case .serverError: ["error"]
        case .unknown(let type, _): [type]
        }
    }
}
