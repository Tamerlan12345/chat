import Foundation

/// WebSocket клиент CentyChat с поддержкой автореконнекта, heartbeat ping/pong и бинарного аудио-релея
public actor WebSocketClient {
    public static let shared = WebSocketClient()
    
    // MARK: - State
    
    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var isConnected = false
    private var isIntentionalDisconnect = false
    
    // Backoff
    private var reconnectAttempt = 0
    private let baseBackoffSeconds: Double = 1.0
    private let maxBackoffSeconds: Double = 30.0
    
    // Heartbeat
    private var pingTask: Task<Void, Never>?
    private let pingIntervalSeconds: UInt64 = 30
    
    // Event Streams
    private var eventContinuation: AsyncStream<WSServerEvent>.Continuation?
    private var audioContinuation: AsyncStream<AudioRelayEngine.DecodedAudioFrame>.Continuation?
    
    public init() {}
    
    // MARK: - Streams
    
    public var events: AsyncStream<WSServerEvent> {
        AsyncStream { continuation in
            self.eventContinuation = continuation
        }
    }
    
    public var incomingAudio: AsyncStream<AudioRelayEngine.DecodedAudioFrame> {
        AsyncStream { continuation in
            self.audioContinuation = continuation
        }
    }
    
    // MARK: - Connect / Disconnect
    
    public func connect() {
        guard !isConnected else { return }
        isIntentionalDisconnect = false
        
        let serverUrlString = KeychainManager.shared.serverUrl
        guard let httpUrl = URL(string: serverUrlString) else { return }
        
        var wsComponents = URLComponents(url: httpUrl, resolvingAgainstBaseURL: true)
        wsComponents?.scheme = (httpUrl.scheme == "https") ? "wss" : "ws"
        wsComponents?.path = "/ws"
        
        guard let wsUrl = wsComponents?.url else { return }
        
        let config = URLSessionConfiguration.default
        let session = URLSession(configuration: config)
        self.urlSession = session
        
        var request = URLRequest(url: wsUrl)
        request.timeoutInterval = 15.0
        
        let task = session.webSocketTask(with: request)
        self.webSocketTask = task
        task.resume()
        
        self.isConnected = true
        self.reconnectAttempt = 0
        
        // Автоматически отправляем auth, если токен есть в Keychain
        if let token = KeychainManager.shared.authToken {
            send(clientMessage: .auth(token: token))
        }
        
        startReceiveLoop()
        startPingTimer()
    }
    
    public func disconnect() {
        isIntentionalDisconnect = true
        isConnected = false
        
        pingTask?.cancel()
        pingTask = nil
        
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }
    
    // MARK: - Message Sending
    
    /// Отправка типизированного клиентского сообщения в JSON
    public func send(clientMessage: WSClientMessage) {
        guard isConnected, let data = clientMessage.toJSONData() else { return }
        guard let jsonString = String(data: data, encoding: .utf8) else { return }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        webSocketTask?.send(message) { error in
            if let error = error {
                print("[WebSocketClient] Send error: \(error)")
            }
        }
    }
    
    /// Отправка бинарного аудиокадра (1028 байт)
    public func sendAudioFrame(_ data: Data) {
        guard isConnected, data.count == AudioRelayEngine.frameSizeBytes else { return }
        
        let message = URLSessionWebSocketTask.Message.data(data)
        webSocketTask?.send(message) { error in
            if let error = error {
                print("[WebSocketClient] Audio frame send error: \(error)")
            }
        }
    }
    
    // MARK: - Receive Loop
    
    private func startReceiveLoop() {
        Task { [weak self] in
            while let self = self, await self.isConnected {
                guard let task = await self.webSocketTask else { break }
                
                do {
                    let message = try await task.receive()
                    await self.handleReceivedMessage(message)
                } catch {
                    print("[WebSocketClient] Receive error / disconnected: \(error)")
                    await self.handleDisconnect()
                    break
                }
            }
        }
    }
    
    private func handleReceivedMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            guard let data = text.data(using: .utf8) else { return }
            if let event = WSServerEvent.parse(from: data) {
                eventContinuation?.yield(event)
            }
            
        case .data(let data):
            if data.count == AudioRelayEngine.frameSizeBytes {
                if let decoded = AudioRelayEngine.decodeFrame(data: data) {
                    audioContinuation?.yield(decoded)
                }
            } else if let event = WSServerEvent.parse(from: data) {
                eventContinuation?.yield(event)
            }
            
        @unknown default:
            break
        }
    }
    
    // MARK: - Heartbeat Ping / Pong
    
    private func startPingTimer() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                guard let self = self, await self.isConnected else { break }
                
                await self.sendPing()
            }
        }
    }
    
    private func sendPing() {
        webSocketTask?.sendPing { [weak self] error in
            if let error = error {
                print("[WebSocketClient] Ping failed: \(error)")
                Task { [weak self] in
                    await self?.handleDisconnect()
                }
            }
        }
    }
    
    // MARK: - Reconnection Logic with Exponential Backoff
    
    private func handleDisconnect() {
        guard !isIntentionalDisconnect else { return }
        
        isConnected = false
        pingTask?.cancel()
        pingTask = nil
        webSocketTask = nil
        
        reconnectAttempt += 1
        
        // Экспоненциальный бэкофф: 1s, 2s, 4s... до 30s + джиттер 20%
        let exponentialDelay = min(maxBackoffSeconds, baseBackoffSeconds * pow(2.0, Double(min(reconnectAttempt, 6))))
        let jitter = Double.random(in: -0.2...0.2) * exponentialDelay
        let delay = max(1.0, exponentialDelay + jitter)
        
        print("[WebSocketClient] Reconnecting in \(String(format: "%.1f", delay))s (attempt \(reconnectAttempt))...")
        
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self = self, await !self.isIntentionalDisconnect else { return }
            await self.connect()
        }
    }
}
