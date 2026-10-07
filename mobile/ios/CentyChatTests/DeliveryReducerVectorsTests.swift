import Foundation
import XCTest
@testable import CentyChat

/// Runs every vector of `mobile/contracts/fixtures/reducers/*.json` (the whole folder, not a list)
/// through `DeliveryReducer` (`fixtures/reducers/README.md`): each event's effects exactly, then each
/// key of `expectedState`, and that the input state of a step is never changed.
final class DeliveryReducerVectorsTests: XCTestCase {
    private func vectorFiles() throws -> [URL] {
        let bundle = Bundle(for: DeliveryReducerVectorsTests.self)
        let root = try XCTUnwrap(bundle.url(forResource: "fixtures", withExtension: nil), "fixtures folder is not bundled")
        return try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("reducers"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testEveryReducerVectorPasses() throws {
        let files = try vectorFiles()
        XCTAssertGreaterThanOrEqual(files.count, 70, "reducer vectors look truncated (01–70 on 2026-10-05)")
        var passed = 0
        for file in files {
            let data = try Data(contentsOf: file)
            guard let vector = JSONValue.parse(data) else {
                XCTFail("\(file.lastPathComponent): not JSON")
                continue
            }
            let failures = DeliveryVectorRunner.run(vector, name: file.deletingPathExtension().lastPathComponent)
            if failures.isEmpty {
                passed += 1
            } else {
                for failure in failures {
                    XCTFail("\(file.lastPathComponent): \(failure)")
                }
            }
        }
        XCTAssertEqual(passed, files.count, "\(passed)/\(files.count) reducer vectors pass")
    }

    // MARK: - The runner itself (parity: as strict as Android's `DeliveryReducerVectorsTest`)

    /// The empty online state of account 2, with one queued `cancel` op of an unsent message.
    private static let stateWithACancelOp = #"""
    {"me":2,"connection":"online","visible":null,"sync":{"cursor":"c.1","running":false,"bootstrap":false,"chain":0},
     "seq":0,"outbox":[],"ops":[{"op":"cancel","message_id":null,"client_msg_id":"a0000300-0000-4000-8000-000000000300",
     "text":null,"state":"queued","attempts":0,"failures":0,"ack_deadline":null,"next_attempt_at":null}],
     "messages":{},"unread":{},"sendLog":[],"opsLog":[],"wake_at":null,"cancelled":["a0000300-0000-4000-8000-000000000300"]}
    """#

    private func vector(name: String = "x", events: String = "[]", effects: String = "[]", expectedState: String = "{}") -> JSONValue {
        let json = #"{"name":"\#(name)","initialState":\#(Self.stateWithACancelOp),"events":\#(events),"expectedEffects":\#(effects),"expectedState":\#(expectedState)}"#
        guard let value = JSONValue.parse(Data(json.utf8)) else { fatalError("bad test vector") }
        return value
    }

    func testAKeyTheStateDoesNotHaveIsAFailureNotNull() {
        XCTAssertFalse(DeliveryVectorRunner.run(vector(expectedState: #"{"no_such_key":null}"#), name: "x").isEmpty)
        XCTAssertTrue(DeliveryVectorRunner.run(vector(expectedState: #"{"wake_at":null}"#), name: "x").isEmpty)
    }

    func testEveryEventNeedsItsOwnEffectList() {
        let events = #"[{"type":"ws","now":1000,"frame":{"type":"user_typing","userId":3}},{"type":"ws","now":1001,"frame":{"type":"user_typing","userId":3}}]"#
        XCTAssertFalse(DeliveryVectorRunner.run(vector(events: events, effects: "[[]]"), name: "x").isEmpty)
        XCTAssertFalse(DeliveryVectorRunner.run(vector(events: "[]", effects: "[[]]"), name: "x").isEmpty)
    }

    func testTheVectorNameMatchesItsFile() {
        XCTAssertFalse(DeliveryVectorRunner.run(vector(name: "01-other"), name: "02-this-file").isEmpty)
        XCTAssertTrue(DeliveryVectorRunner.run(vector(name: "02-this-file"), name: "02-this-file").isEmpty)
    }

    /// `message_deleted` without an integer `messageId` confirms nothing: the queued cancel of an
    /// unsent message (whose op has no message id) stays (parity minor; Android guards the same way).
    func testADeletedFrameWithoutAnIdKeepsPendingCancels() {
        let events = #"[{"type":"ws","now":1000,"frame":{"type":"message_deleted","conversationType":"direct","targetId":3}},{"type":"ws","now":1001,"frame":{"type":"message_deleted","messageId":null,"conversationType":"direct","targetId":3}},{"type":"ws","now":1002,"frame":{"type":"message_deleted","messageId":"77","conversationType":"direct","targetId":3}}]"#
        let ops = #"{"ops":[{"op":"cancel","message_id":null,"client_msg_id":"a0000300-0000-4000-8000-000000000300","text":null,"state":"queued","attempts":0,"failures":0,"ack_deadline":null,"next_attempt_at":null}]}"#
        let failures = DeliveryVectorRunner.run(vector(events: events, effects: "[[],[],[]]", expectedState: ops), name: "x")
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
    }

    /// The projection reads and writes the contract's shape (§3) without losing anything.
    func testTheStateProjectionRoundTripsEveryInitialState() throws {
        for file in try vectorFiles() {
            let vector = try XCTUnwrap(JSONValue.parse(try Data(contentsOf: file)))
            let initial = try XCTUnwrap(vector["initialState"])
            XCTAssertEqual(DeliveryState(json: initial).json, initial, file.lastPathComponent)
        }
    }
}

/// Applies a vector (`{ initialState, events, expectedEffects, expectedState }`) and lists what differs.
enum DeliveryVectorRunner {
    static func run(_ vector: JSONValue, name: String) -> [String] {
        var failures: [String] = []
        guard let initial = vector["initialState"], let events = vector["events"]?.array,
              let expectedEffects = vector["expectedEffects"]?.array else {
            return ["missing initialState, events or expectedEffects"]
        }
        var state = DeliveryState(json: initial)
        for (index, event) in events.enumerated() {
            guard let object = event.object else {
                failures.append("event \(index) is not an object")
                continue
            }
            let before = state
            let step = DeliveryReducer.reduce(state, object)
            if state != before {
                failures.append("event \(index) changed its input state")
            }
            let effects = JSONValue.array(step.effects.map(\.json))
            let expected = index < expectedEffects.count ? expectedEffects[index] : .array([])
            if effects != expected {
                failures.append("event \(index) (\(object["type"]?.string ?? "?")) effects\n  expected \(expected.jsonText)\n  actual   \(effects.jsonText)")
            }
            state = step.state
        }
        let actual = state.json
        for (key, expected) in vector["expectedState"]?.object ?? [:] {
            let value = actual[key] ?? .null
            if value != expected {
                failures.append("state.\(key)\n  expected \(expected.jsonText)\n  actual   \(value.jsonText)")
            }
        }
        return failures
    }
}
