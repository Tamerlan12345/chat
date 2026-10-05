import Foundation

/// Side effects of one reducer step (`delivery-state.md` §5), executed strictly in order.
public enum DeliveryEffect: Sendable, Equatable {
    /// Barrier: durably write these slices of the new state before anything else runs.
    case persist(slices: [String])
    case clearComposer(conversation: String)
    case sendWs(frame: JSONObject)
    case sendHttp(clientMsgId: String, attempt: Int64, method: String, path: String, body: JSONObject)
    /// Dispatch `event` (plus `now`) at or after `at`.
    case schedule(at: Int64, event: JSONObject)
    case syncRequest(cursor: String?, limit: Int64, chain: Int64)
    case refreshConversationLists
    case loadHistory(conversation: String)
    case userError(code: String)

    public var json: JSONValue {
        switch self {
        case .persist(let slices):
            return ["type": "persist", "slices": .array(slices.map(JSONValue.string))]
        case .clearComposer(let conversation):
            return ["type": "clear_composer", "conversation": .string(conversation)]
        case .sendWs(let frame):
            return ["type": "send_ws", "frame": .object(frame)]
        case .sendHttp(let clientMsgId, let attempt, let method, let path, let body):
            return [
                "type": "send_http",
                "client_msg_id": .string(clientMsgId),
                "attempt": .int(attempt),
                "method": .string(method),
                "path": .string(path),
                "body": .object(body),
            ]
        case .schedule(let at, let event):
            return ["type": "schedule", "at": .int(at), "event": .object(event)]
        case .syncRequest(let cursor, let limit, let chain):
            return ["type": "sync_request", "cursor": .orNull(cursor), "limit": .int(limit), "chain": .int(chain)]
        case .refreshConversationLists:
            return ["type": "refresh_conversation_lists"]
        case .loadHistory(let conversation):
            return ["type": "load_history", "conversation": .string(conversation)]
        case .userError(let code):
            return ["type": "user_error", "code": .string(code)]
        }
    }
}
