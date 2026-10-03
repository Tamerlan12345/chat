import Foundation
import Security
import XCTest
@testable import CentyChat

/// All user-facing copy is Russian and lives in the `ru` String Catalog.
final class LocalizationTests: XCTestCase {
    private var appBundle: Bundle { Bundle(for: AppContainer.self) }

    func testRussianStringCatalogIsCompiledIntoTheApp() throws {
        let path = appBundle.path(forResource: "Localizable", ofType: "strings", inDirectory: nil, forLocalization: "ru")
        let table = try XCTUnwrap(path.flatMap { NSDictionary(contentsOfFile: $0) as? [String: String] },
                                  "Localizable.xcstrings must compile into ru.lproj/Localizable.strings")
        for key in ["Войти", "Сервер временно недоступен", "Повторить", "Сигнал от коллеги", "%@ печатает...", "ОК", "Эл. почта"] {
            XCTAssertNotNil(table[key], "Missing catalog entry: \(key)")
        }
    }

    func testKeychainErrorsAreRussian() {
        let errors: [KeychainManagerError] = [
            .invalidValue,
            .updateFailed(status: errSecAuthFailed),
            .addFailed(status: errSecAuthFailed),
            .deleteFailed(status: errSecAuthFailed),
        ]
        for error in errors {
            assertRussian(error.errorDescription, "\(error)")
        }
    }

    func testNetworkErrorsAreRussian() {
        let errors: [APIError] = [
            .invalidURL("chat"),
            .insecureTransport,
            .invalidResponse,
            .unauthorized,
            .decodingError("x"),
            .noConnection,
        ]
        for error in errors {
            assertRussian(error.errorDescription, "\(error)")
        }
    }

    func testStatusAndCallLabelsAreRussian() {
        for status in UserStatus.allCases {
            assertRussian(status.displayName, "\(status)")
        }
        for state in [CallState.idle, .calling, .ringing, .connecting, .active, .ended, .failed] {
            assertRussian(state.descriptionRu, "\(state)")
        }
    }

    private func assertRussian(_ text: String?, _ context: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let text, !text.isEmpty else {
            return XCTFail("\(context) has no description", file: file, line: line)
        }
        let hasCyrillic = text.unicodeScalars.contains { (0x0400...0x04FF).contains($0.value) }
        XCTAssertTrue(hasCyrillic, "\(context) is not Russian: \(text)", file: file, line: line)
    }
}

/// Calls report audio problems in Russian.
@MainActor
final class CallLocalizationTests: XCTestCase {
    func testMicrophoneDenialIsExplainedInRussian() async {
        let calls = CallStore(
            realtime: RealtimeStore(repository: FakeRealtimeRepository()),
            audioRelayFactory: { peerId in
                let backend = SilentAudioBackend()
                backend.recordPermission = .denied
                return AudioCallRelay(targetUserId: peerId, backend: backend, sendFrame: { _ in })
            }
        )
        calls.activeCall = CallSession(peerId: 42, peerName: "Коллега", state: .calling, direction: .outgoing)

        await calls.activateAcceptedOutgoingCall(for: 42)

        let message = calls.callAudioError ?? ""
        XCTAssertTrue(message.unicodeScalars.contains { (0x0400...0x04FF).contains($0.value) }, message)
    }
}
