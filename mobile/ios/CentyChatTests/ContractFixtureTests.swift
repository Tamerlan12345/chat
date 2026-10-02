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
        XCTAssertGreaterThanOrEqual(entries.count, 80, "The manifest looks truncated")

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
            default:
                XCTFail("\(file): unknown fixture kind \(entry.kind)")
            }
        }
    }

    func testEveryFixtureFileIsListedInTheManifest() throws {
        let root = try fixturesRoot()
        let listed = Set(try manifest().keys)
        for folder in ["http", "ws"] {
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
        default:
            XCTFail("\(file): no DTO is mapped to this fixture; add one before the contract can ship")
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
