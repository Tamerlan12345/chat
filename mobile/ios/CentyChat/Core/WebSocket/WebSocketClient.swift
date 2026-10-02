import Foundation

/// Observable state of the realtime socket.
public enum RealtimeConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int, delay: TimeInterval)
}

/// Exponential reconnect delay: 1 s, 2 s, 4 s … capped at 30 s, with ±20 % jitter.
struct ReconnectBackoff: Sendable {
    static let baseSeconds: TimeInterval = 1
    static let maxSeconds: TimeInterval = 30

    private(set) var attempt = 0

    /// Advances to the next attempt. `jitter` is a factor in -0.2...0.2.
    mutating func nextDelay(jitter: Double) -> TimeInterval {
        attempt += 1
        let exponential = min(Self.maxSeconds, Self.baseSeconds * pow(2.0, Double(min(attempt, 6))))
        return max(Self.baseSeconds, exponential + jitter * exponential)
    }

    mutating func reset() {
        attempt = 0
    }
}

/// WebSocket клиент CentyChat с поддержкой автореконнекта, heartbeat ping/pong и бинарного аудио-релея
public actor WebSocketClient {
    public static let shared = WebSocketClient()

    typealias Credentials = @Sendable () -> (serverURL: String, token: String?)
    typealias TransportFactory = @Sendable (URLRequest) -> any WebSocketTransport
    typealias Sleeper = @Sendable (TimeInterval) async throws -> Void

    // MARK: - Dependencies

    private let credentials: Credentials
    private let makeTransport: TransportFactory
    private let sleep: Sleeper
    private let jitter: @Sendable () -> Double

    // MARK: - State

    private var transport: (any WebSocketTransport)?
    private var generation = 0
    private var isIntentionalDisconnect = false
    private var backoff = ReconnectBackoff()
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    public private(set) var connectionState: RealtimeConnectionState = .disconnected {
        didSet {
            guard connectionState != oldValue else { return }
            stateContinuation?.yield(connectionState)
        }
    }

    // Heartbeat
    private var pingTask: Task<Void, Never>?
    private let pingIntervalSeconds: TimeInterval

    // Event Streams
    private var eventContinuation: AsyncStream<WSServerEvent>.Continuation?
    private var stateContinuation: AsyncStream<RealtimeConnectionState>.Continuation?
    private let incomingAudioBufferCapacity = 8
    private var audioContinuation: AsyncStream<AudioRelayEngine.DecodedAudioFrame>.Continuation?
    private var audioContinuationID: UUID?

    init(
        credentials: @escaping Credentials = { (KeychainManager.shared.serverUrl, KeychainManager.shared.authToken) },
        makeTransport: @escaping TransportFactory = { URLSessionWebSocketTransport(request: $0) },
        sleep: @escaping Sleeper = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: -0.2...0.2) },
        pingIntervalSeconds: TimeInterval = 30
    ) {
        self.credentials = credentials
        self.makeTransport = makeTransport
        self.sleep = sleep
        self.jitter = jitter
        self.pingIntervalSeconds = pingIntervalSeconds
    }

    // MARK: - Streams

    /// Single subscriber stream of parsed server events. A new subscription finishes the previous one.
    public func makeEventStream() -> AsyncStream<WSServerEvent> {
        eventContinuation?.finish()
        let (stream, continuation) = AsyncStream<WSServerEvent>.makeStream()
        eventContinuation = continuation
        return stream
    }

    /// Connection state updates, starting with the current state.
    public func makeConnectionStateStream() -> AsyncStream<RealtimeConnectionState> {
        stateContinuation?.finish()
        let (stream, continuation) = AsyncStream<RealtimeConnectionState>.makeStream(
            bufferingPolicy: .bufferingNewest(16)
        )
        stateContinuation = continuation
        continuation.yield(connectionState)
        return stream
    }

    public var incomingAudio: AsyncStream<AudioRelayEngine.DecodedAudioFrame> {
        let subscriberID = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(incomingAudioBufferCapacity)) { continuation in
            audioContinuation?.finish()
            self.audioContinuation = continuation
            self.audioContinuationID = subscriberID
            continuation.onTermination = { [weak self] _ in
                Task {
                    await self?.clearIncomingAudioContinuation(id: subscriberID)
                }
            }
        }
    }

    // MARK: - Connect / Disconnect

    public func connect() {
        guard transport == nil else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        isIntentionalDisconnect = false

        let current = credentials()
        guard let serverURL = ServerEndpointPolicy.configuredURL(from: current.serverURL),
              let wsUrl = ServerEndpointPolicy.webSocketURL(for: serverURL) else {
            Log.realtime.error("WebSocket connect skipped: no secure server URL is configured")
            return
        }
        guard current.token == nil || ServerEndpointPolicy.allowsAuthorization(to: wsUrl) else {
            Log.realtime.error("WebSocket connect refused: authorization requires a secure transport")
            return
        }

        var request = URLRequest(url: wsUrl)
        request.timeoutInterval = 15.0

        let transport = makeTransport(request)
        self.transport = transport
        generation += 1
        backoff.reset()
        connectionState = .connecting
        transport.resume()

        // Автоматически отправляем auth, если токен есть в Keychain
        if let token = current.token {
            send(clientMessage: .auth(token: token))
        }

        startReceiveLoop(transport: transport, generation: generation)
        startPingTimer(generation: generation)
    }

    public func disconnect() {
        isIntentionalDisconnect = true
        generation += 1
        tearDownTransport()
        reconnectTask?.cancel()
        reconnectTask = nil
        backoff.reset()
        connectionState = .disconnected
        finishIncomingAudioStream()
    }

    // MARK: - Message Sending

    /// Отправка типизированного клиентского сообщения в JSON
    public func send(clientMessage: WSClientMessage) {
        guard let transport,
              let data = clientMessage.toJSONData(),
              let jsonString = String(data: data, encoding: .utf8) else { return }

        transport.send(.text(jsonString)) { error in
            if let error {
                Log.realtime.error("Send failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Отправка бинарного аудиокадра (1028 байт)
    public func sendAudioFrame(_ data: Data) {
        guard let transport, data.count == AudioRelayEngine.frameSizeBytes else { return }
        transport.send(.binary(data)) { error in
            if let error {
                Log.realtime.error("Audio frame send failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Receive Loop

    private func startReceiveLoop(transport: any WebSocketTransport, generation: Int) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let frame = try await transport.receive()
                    await self?.handleReceived(frame, generation: generation)
                } catch {
                    let reason = error.localizedDescription
                    await self?.handleTransportFailure(reason: reason, generation: generation)
                    return
                }
            }
        }
    }

    private func handleReceived(_ frame: WebSocketFrame, generation: Int) {
        guard generation == self.generation else { return }
        if connectionState != .connected {
            connectionState = .connected
        }
        switch frame {
        case .text(let text):
            guard let data = text.data(using: .utf8) else { return }
            if let event = WSServerEvent.parse(from: data) {
                eventContinuation?.yield(event)
            }

        case .binary(let data):
            if data.count == AudioRelayEngine.frameSizeBytes {
                receiveIncomingAudioFrame(data)
            } else if let event = WSServerEvent.parse(from: data) {
                eventContinuation?.yield(event)
            }
        }
    }

    /// Accepts one binary relay frame and retains only the newest frames for the audio consumer.
    func receiveIncomingAudioFrame(_ data: Data) {
        guard data.count == AudioRelayEngine.frameSizeBytes,
              let decoded = AudioRelayEngine.decodeFrame(data: data) else {
            return
        }
        audioContinuation?.yield(decoded)
    }

    private func clearIncomingAudioContinuation(id: UUID) {
        guard audioContinuationID == id else { return }
        audioContinuation = nil
        audioContinuationID = nil
    }

    private func finishIncomingAudioStream() {
        audioContinuation?.finish()
        audioContinuation = nil
        audioContinuationID = nil
    }

    // MARK: - Heartbeat Ping / Pong

    private func startPingTimer(generation: Int) {
        pingTask?.cancel()
        let interval = pingIntervalSeconds
        let sleep = self.sleep
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await sleep(interval)
                } catch {
                    return
                }
                guard let self, !Task.isCancelled else { return }
                await self.sendPing(generation: generation)
            }
        }
    }

    private func sendPing(generation: Int) {
        guard generation == self.generation, let transport else { return }
        transport.sendPing { [weak self] error in
            guard let error else { return }
            let reason = error.localizedDescription
            Log.realtime.error("Ping failed: \(reason, privacy: .public)")
            Task { [weak self] in
                await self?.handleTransportFailure(reason: reason, generation: generation)
            }
        }
    }

    // MARK: - Reconnection Logic with Exponential Backoff

    private func tearDownTransport() {
        pingTask?.cancel()
        pingTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        transport?.cancel()
        transport = nil
    }

    private func handleTransportFailure(reason: String, generation: Int) {
        guard generation == self.generation, !isIntentionalDisconnect else { return }
        Log.realtime.error("Socket closed: \(reason, privacy: .public)")
        self.generation += 1
        tearDownTransport()

        let delay = backoff.nextDelay(jitter: jitter())
        let attempt = backoff.attempt
        connectionState = .reconnecting(attempt: attempt, delay: delay)
        Log.realtime.info("Reconnecting in \(delay, format: .fixed(precision: 1), privacy: .public)s (attempt \(attempt, privacy: .public))")

        let sleep = self.sleep
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do {
                try await sleep(delay)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self?.reconnectAfterBackoff()
        }
    }

    private func reconnectAfterBackoff() {
        guard !isIntentionalDisconnect else { return }
        reconnectTask = nil
        connect()
    }
}
