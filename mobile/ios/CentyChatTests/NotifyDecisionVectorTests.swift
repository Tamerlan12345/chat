import Foundation
import XCTest
@testable import CentyChat

/// Runs every vector of `mobile/contracts/fixtures/notify/*.json` against the Swift port of
/// `reference/notify-decision.mjs`. A vector the port cannot run, or answers differently, fails.
final class NotifyDecisionVectorTests: XCTestCase {
    private struct ReadInput: Decodable {
        let sockets: [NotifyDecision.Socket]?
        let pushDevices: [NotifyDecision.PushDevice]?
    }

    private struct MessageExpected: Decodable {
        let reason: NotifyDecision.Reason?
        let push: [String]
        let banner: [String]
        let quiet: [String]
    }

    private struct CallExpected: Decodable {
        let reason: NotifyDecision.Reason?
        let push: [String]
        let ring: [String]
        let quiet: [String]
    }

    private struct ReadExpected: Decodable {
        let push: [String]
    }

    private struct Header: Decodable {
        let name: String
        let decision: String
    }

    private struct Vector<Input: Decodable, Expected: Decodable>: Decodable {
        let input: Input
        let expected: Expected
    }

    private func vectorFiles() throws -> [URL] {
        let bundle = Bundle(for: NotifyDecisionVectorTests.self)
        let root = try XCTUnwrap(bundle.url(forResource: "fixtures", withExtension: nil), "fixtures folder is not bundled")
        let folder = root.appendingPathComponent("notify")
        return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testEveryNotifyVectorMatchesTheReference() throws {
        let files = try vectorFiles()
        XCTAssertGreaterThanOrEqual(files.count, 20, "notify vectors look truncated (01–18, c01–c10, r01, r02 on 2026-10-03)")
        var ran = 0
        let decoder = JSONDecoder()
        for file in files {
            let name = file.lastPathComponent
            let data = try Data(contentsOf: file)
            let header = try decoder.decode(Header.self, from: data)
            switch header.decision {
            case "message":
                let vector: Vector<NotifyDecision.MessageInput, MessageExpected>
                do {
                    vector = try decoder.decode(Vector<NotifyDecision.MessageInput, MessageExpected>.self, from: data)
                } catch {
                    XCTFail("\(name): does not decode: \(error)")
                    continue
                }
                let outcome = NotifyDecision.decideMessageNotification(vector.input)
                XCTAssertEqual(outcome.reason, vector.expected.reason, "\(name): reason")
                XCTAssertEqual(outcome.push, vector.expected.push, "\(name): push")
                XCTAssertEqual(outcome.banner, vector.expected.banner, "\(name): banner")
                XCTAssertEqual(outcome.quiet, vector.expected.quiet, "\(name): quiet")
                ran += 1
            case "read":
                let vector: Vector<ReadInput, ReadExpected>
                do {
                    vector = try decoder.decode(Vector<ReadInput, ReadExpected>.self, from: data)
                } catch {
                    XCTFail("\(name): does not decode: \(error)")
                    continue
                }
                let push = NotifyDecision.decideReadDismissal(
                    sockets: vector.input.sockets ?? [],
                    pushDevices: vector.input.pushDevices ?? []
                )
                XCTAssertEqual(push, vector.expected.push, "\(name): push")
                ran += 1
            case "call":
                let vector: Vector<NotifyDecision.CallInput, CallExpected>
                do {
                    vector = try decoder.decode(Vector<NotifyDecision.CallInput, CallExpected>.self, from: data)
                } catch {
                    XCTFail("\(name): does not decode: \(error)")
                    continue
                }
                let outcome = NotifyDecision.decideCallNotification(vector.input)
                XCTAssertEqual(outcome.reason, vector.expected.reason, "\(name): reason")
                XCTAssertEqual(outcome.push, vector.expected.push, "\(name): push")
                XCTAssertEqual(outcome.ring, vector.expected.ring, "\(name): ring")
                XCTAssertEqual(outcome.quiet, vector.expected.quiet, "\(name): quiet")
                ran += 1
            default:
                XCTFail("\(name): unknown decision \(header.decision)")
            }
        }
        XCTAssertEqual(ran, files.count, "every vector must run")
    }

    func testDirectChatIsTheColleagueAndAChannelIsItsId() {
        let incoming = NotifyDecision.MessageRef(conversationType: "direct", targetId: 2, senderId: 5)
        XCTAssertEqual(NotifyDecision.chatOf(incoming, recipientId: 2), .init(conversationType: "direct", targetId: 5))
        let own = NotifyDecision.MessageRef(conversationType: "direct", targetId: 5, senderId: 2)
        XCTAssertEqual(NotifyDecision.chatOf(own, recipientId: 2), .init(conversationType: "direct", targetId: 5))
        let channel = NotifyDecision.MessageRef(conversationType: "channel", targetId: 7, senderId: 5)
        XCTAssertEqual(NotifyDecision.chatOf(channel, recipientId: 2), .init(conversationType: "channel", targetId: 7))
    }

    func testAnAwaySocketIsNeverViewing() {
        let chat = NotifyDecision.Chat(conversationType: "direct", targetId: 5)
        let away = NotifyDecision.Socket(id: "s", deviceId: "d", presence: "away", viewing: chat)
        XCTAssertFalse(NotifyDecision.isViewing(away, chat))
        let online = NotifyDecision.Socket(id: "s", deviceId: "d", presence: "online", viewing: chat)
        XCTAssertTrue(NotifyDecision.isViewing(online, chat))
    }
}
