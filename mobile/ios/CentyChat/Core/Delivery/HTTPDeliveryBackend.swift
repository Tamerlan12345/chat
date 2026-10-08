import Foundation

/// `/api/sync`, history pages, the conversation lists and `POST /api/messages/...` through `APIClient`.
struct HTTPDeliveryBackend: DeliveryBackend {
    static let historyPage = 50

    let client: APIClient
    /// UI tests of the offline queue: the message transport is down (`LaunchTestFixture.deliveryOffline`).
    var offline: @Sendable () -> Bool = { LaunchTestFixture.deliveryOffline }

    func sync(cursor: String?, limit: Int64) async -> SyncOutcome {
        if offline() { return .failed(status: 0, retryAfterMs: nil) }
        var query = [URLQueryItem(name: "limit", value: "\(limit)")]
        if let cursor { query.append(URLQueryItem(name: "since", value: cursor)) }
        let response = await client.raw(method: "GET", endpoint: "/sync", queryItems: query)
        let body = JSONValue.parse(response.body)?.object
        switch response.status {
        case 200:
            // An unreadable page is retried like a network failure.
            return body.map(SyncOutcome.page) ?? .failed(status: 0, retryAfterMs: nil)
        case 410:
            return .cursorInvalid(body ?? [:])
        default:
            return .failed(status: response.status, retryAfterMs: response.retryAfterSeconds.map { Int64($0 * 1_000) })
        }
    }

    func history(_ conversation: String) async throws -> [JSONObject] {
        let (type, id) = DeliveryReducer.parseConversation(conversation)
        guard let conversationType = ConversationType(rawValue: type) else { return [] }
        return try await client.getMessageRecords(conversationType: conversationType, targetId: id, limit: Self.historyPage)
    }

    func unreadSnapshot() async throws -> UnreadSnapshot {
        async let channels = client.raw(method: "GET", endpoint: "/channels")
        async let direct = client.raw(method: "GET", endpoint: "/conversations/direct")
        let (channelList, directList) = await (channels, direct)
        // A failure of either list skips the snapshot (the next chain asks again).
        guard channelList.status == 200, directList.status == 200,
              let channelRows = JSONValue.parse(channelList.body)?.array,
              let directRows = JSONValue.parse(directList.body)?.array else {
            throw APIError.httpError(statusCode: channelList.status == 200 ? directList.status : channelList.status, message: "lists", code: nil)
        }
        var counts: [String: Int64] = [:]
        var last: [String: Int64?] = [:]
        for row in channelRows.compactMap(\.object) {
            guard let id = row["id"]?.int64 else { continue }
            counts["channel:\(id)"] = row["unread_count"]?.int64 ?? 0
            // A null id stays as null: the key itself says the list has the field (G7).
            if let value = row["last_message_id"] { last.updateValue(value.int64, forKey: "channel:\(id)") }
        }
        for row in directRows.compactMap(\.object) {
            guard let id = row["user_id"]?.int64 else { continue }
            counts["direct:\(id)"] = row["unread_count"]?.int64 ?? 0
            if let value = row["last_message_id"] { last.updateValue(value.int64, forKey: "direct:\(id)") }
        }
        return UnreadSnapshot(counts: counts, lastMessageIds: last)
    }

    func post(path: String, body: JSONObject) async -> HTTPOutcome {
        if offline() { return HTTPOutcome(status: 0, body: nil) }
        // The effect's path is absolute (`/api/messages/direct/3`); the client adds `/api` itself.
        let endpoint = path.hasPrefix("/api/") ? String(path.dropFirst(4)) : path
        let response = await client.raw(method: "POST", endpoint: endpoint, body: JSONValue.object(body).jsonData)
        return HTTPOutcome(status: response.status, body: JSONValue.parse(response.body))
    }
}
