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
            let failures = DeliveryVectorRunner.run(vector)
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
    static func run(_ vector: JSONValue) -> [String] {
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
