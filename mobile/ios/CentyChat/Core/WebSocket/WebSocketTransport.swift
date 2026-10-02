import Foundation

/// One WebSocket frame, independent of the URLSession message type.
public enum WebSocketFrame: Sendable, Equatable {
    case text(String)
    case binary(Data)
}

/// The socket primitive `WebSocketClient` drives. Abstracted so reconnection
/// policy can be tested without a network.
protocol WebSocketTransport: AnyObject, Sendable {
    func resume()
    /// Enqueues a frame. Frames are delivered in call order.
    func send(_ frame: WebSocketFrame, completion: @escaping @Sendable (Error?) -> Void)
    func receive() async throws -> WebSocketFrame
    func sendPing(completion: @escaping @Sendable (Error?) -> Void)
    func cancel()
}

enum WebSocketTransportError: Error {
    case unsupportedFrame
}

/// Production transport backed by `URLSessionWebSocketTask`.
/// Both stored properties are immutable references to thread-safe Foundation types.
final class URLSessionWebSocketTransport: WebSocketTransport, @unchecked Sendable {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(request: URLRequest) {
        session = URLSession(configuration: .default)
        task = session.webSocketTask(with: request)
    }

    func resume() {
        task.resume()
    }

    func send(_ frame: WebSocketFrame, completion: @escaping @Sendable (Error?) -> Void) {
        let message: URLSessionWebSocketTask.Message
        switch frame {
        case .text(let text): message = .string(text)
        case .binary(let data): message = .data(data)
        }
        task.send(message, completionHandler: completion)
    }

    func receive() async throws -> WebSocketFrame {
        switch try await task.receive() {
        case .string(let text): return .text(text)
        case .data(let data): return .binary(data)
        @unknown default: throw WebSocketTransportError.unsupportedFrame
        }
    }

    func sendPing(completion: @escaping @Sendable (Error?) -> Void) {
        task.sendPing(pongReceiveHandler: completion)
    }

    func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}
