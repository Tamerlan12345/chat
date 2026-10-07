import Foundation

/// Observable state of the realtime socket.
public enum RealtimeConnectionState: Sendable, Equatable {
    case disconnected
    /// Socket opening and `auth` sent; not usable until the server answers `auth_success`.
    case connecting
    /// The server accepted the session (`auth_success`).
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
        let exponent = Double(min(attempt - 1, 16))
        let exponential = min(Self.maxSeconds, Self.baseSeconds * pow(2.0, exponent))
        return min(Self.maxSeconds, max(Self.baseSeconds, exponential + jitter * exponential))
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
    /// Device fields for the `auth` frame, read at every connect (presence and the open chat change).
    typealias HandshakeProvider = @Sendable () -> AuthHandshake

    // MARK: - Dependencies

    private let credentials: Credentials
    /// False while the stored session cannot be read (before the first unlock).
    private let tokenReadable: @Sendable () -> Bool
    private let handshake: HandshakeProvider
    private let makeTransport: TransportFactory
    private let sleep: Sleeper
    private let jitter: @Sendable () -> Double

    // MARK: - State

    private var transport: (any WebSocketTransport)?
    private var generation = 0
    private var isIntentionalDisconnect = false
    private var backoff = ReconnectBackoff()
    /// The auth_error code already reported in the current failure streak.
    private var reportedAuthErrorCode: String?
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
    /// Raw frames for the delivery engine (`DeliveryLinkFrame`).
    private var deliveryContinuation: AsyncStream<DeliveryLinkFrame>.Continuation?
    /// The user the open socket authenticated as (`auth_success`); nil otherwise.
    public private(set) var authenticatedUserId: Int64?

    init(
        credentials: @escaping Credentials = {
            (LaunchTestFixture.realtimeServerOverride ?? ServerEnvironment.current.serverURL.absoluteString, KeychainManager.shared.authToken)
        },
        makeTransport: @escaping TransportFactory = { URLSessionWebSocketTransport(request: $0) },
        sleep: @escaping Sleeper = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: -0.2...0.2) },
        pingIntervalSeconds: TimeInterval = 30,
        handshake: @escaping HandshakeProvider = { RealtimeHandshakeState.shared.handshake() },
        tokenReadable: @escaping @Sendable () -> Bool = { KeychainManager.shared.canReadStoredItems }
    ) {
        self.tokenReadable = tokenReadable
        self.credentials = credentials
        self.handshake = handshake
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

    /// Single subscriber stream of every server frame as received (JSON objects, in order), plus
    /// `closed` whenever an open socket goes away. A new subscription finishes the previous one.
    public func makeDeliveryFrameStream() -> AsyncStream<DeliveryLinkFrame> {
        deliveryContinuation?.finish()
        let (stream, continuation) = AsyncStream<DeliveryLinkFrame>.makeStream()
        deliveryContinuation = continuation
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

        // Before the first unlock the stored session cannot be read: a socket without its token
        // would be refused and end the session. Wait with the usual backoff instead (final review I1).
        guard tokenReadable() else {
            Log.realtime.notice("WebSocket connect deferred: the stored session cannot be read yet")
            scheduleReconnect()
            return
        }

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
        connectionState = .connecting
        transport.resume()

        // Автоматически отправляем auth, если токен есть в Keychain
        if let token = current.token {
            send(clientMessage: .auth(token: token, handshake: handshake()))
        }

        startReceiveLoop(transport: transport, generation: generation)
        startPingTimer(generation: generation)
    }

    public func disconnect() {
        isIntentionalDisconnect = true
        generation += 1
        reportClosed()
        tearDownTransport()
        reconnectTask?.cancel()
        reconnectTask = nil
        backoff.reset()
        reportedAuthErrorCode = nil
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

    /// Sends only on an authenticated socket (after `auth_success`). Returns false when the frame
    /// was not sent, so state the server must know (presence, viewing, «Не беспокоить») is re-sent later.
    @discardableResult
    public func sendIfAuthenticated(_ clientMessage: WSClientMessage) -> Bool {
        guard connectionState == .connected, transport != nil else { return false }
        send(clientMessage: clientMessage)
        return true
    }

    /// Writes a delivery frame (`send_message`, `mark_read`, …) only on a socket the server has
    /// authenticated. False when it was not written: the delivery engine treats the socket as gone.
    public func sendFrame(_ frame: JSONObject) -> Bool {
        guard connectionState == .connected, let transport else { return false }
        let text = JSONValue.object(frame).jsonText
        transport.send(.text(text)) { error in
            if let error {
                // The engine's timeout repeats the frame with the same key (delivery-state.md §5).
                Log.realtime.error("Frame send failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        return true
    }

    /// Drops the open socket so it reconnects (with backoff) and authenticates afresh.
    public func restart() {
        guard transport != nil else { return }
        handleTransportFailure(reason: "restart requested", generation: generation)
    }

    /// The network came back: a reconnect waiting for its backoff goes now.
    public func reconnectNow() {
        guard reconnectTask != nil, transport == nil, !isIntentionalDisconnect else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        backoff.reset()
        connect()
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
        switch frame {
        case .text(let text):
            let data = Data(text.utf8)
            // The raw frame first: an auth_error below closes the socket, and its close follows it.
            if let object = JSONValue.parse(data)?.object {
                deliveryContinuation?.yield(.frame(object))
            }
            guard let event = WSServerEvent.parse(from: data) else { return }
            deliver(event, generation: generation)

        case .binary(let data):
            if data.count == AudioRelayEngine.frameSizeBytes {
                receiveIncomingAudioFrame(data)
            } else {
                if let object = JSONValue.parse(data)?.object {
                    deliveryContinuation?.yield(.frame(object))
                }
                if let event = WSServerEvent.parse(from: data) {
                    deliver(event, generation: generation)
                }
            }
        }
    }

    private func deliver(_ event: WSServerEvent, generation: Int) {
        switch event {
        case .authSuccess(let user):
            // Only an accepted session counts as a working connection and resets the backoff.
            authenticatedUserId = user.id
            connectionState = .connected
            backoff.reset()
            reportedAuthErrorCode = nil
            eventContinuation?.yield(event)

        case .authError(let code, _):
            // The server keeps a rejected socket open until its auth timeout; close it now
            // and keep backing off. Report each code once per failure streak, not per retry.
            if reportedAuthErrorCode != code {
                reportedAuthErrorCode = code
                eventContinuation?.yield(event)
            }
            handleTransportFailure(reason: "auth_error \(code)", generation: generation)

        default:
            eventContinuation?.yield(event)
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

    /// An open socket went away: the delivery engine hears it once (`ws_disconnected`).
    private func reportClosed() {
        authenticatedUserId = nil
        guard transport != nil else { return }
        deliveryContinuation?.yield(.closed)
    }

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
        reportClosed()
        tearDownTransport()
        scheduleReconnect()
    }

    /// The next attempt after the backoff's delay.
    private func scheduleReconnect() {
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
