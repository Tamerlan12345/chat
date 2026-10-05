import Foundation

/// A `DeliveryStore` in memory: unit tests, previews and the idle unit-test host. Nothing survives
/// the process. `failing` makes the next operations of a kind throw, as a broken disk would.
public actor InMemoryDeliveryStore: DeliveryStore {
    public enum Operation: Sendable, Hashable {
        case load, persist, writeCache, clear
    }

    public struct Failure: Error, Equatable {
        public let operation: Operation
    }

    private(set) var stored = StoredDelivery()
    private var failing: [Operation: Int] = [:]
    /// Every successful persist, in order: its slices.
    private(set) var persisted: [[String]] = []
    private(set) var clearCount = 0

    public init(_ stored: StoredDelivery = StoredDelivery()) {
        self.stored = stored
    }

    /// The next `times` calls of `operation` throw (`Int.max` — until `heal`).
    public func fail(_ operation: Operation, times: Int = Int.max) {
        failing[operation] = times
    }

    public func heal() {
        failing.removeAll()
    }

    public var contents: StoredDelivery { stored }

    private func check(_ operation: Operation) throws {
        guard let left = failing[operation], left > 0 else { return }
        failing[operation] = left == Int.max ? left : left - 1
        throw Failure(operation: operation)
    }

    public func load() async throws -> StoredDelivery {
        try check(.load)
        return stored
    }

    public func persist(slices: [String], state: DeliveryState, cache: [String: [JSONObject]]) async throws {
        try check(.persist)
        stored.me = state.me
        if slices.contains("cursor") { stored.cursor = state.sync.cursor }
        if slices.contains("outbox") {
            stored.outbox = state.outbox
            stored.seq = state.seq
        }
        if slices.contains("ops") { stored.ops = state.ops }
        if slices.contains("cancelled") { stored.cancelled = state.cancelled }
        apply(cache)
        persisted.append(slices)
    }

    public func writeCache(_ cache: [String: [JSONObject]], me: Int64?) async throws {
        try check(.writeCache)
        stored.me = me
        apply(cache)
    }

    public func clear() async throws {
        try check(.clear)
        stored = StoredDelivery()
        clearCount += 1
    }

    private func apply(_ cache: [String: [JSONObject]]) {
        for (conversation, records) in cache {
            stored.cache[conversation] = records.isEmpty ? nil : records
        }
    }
}
