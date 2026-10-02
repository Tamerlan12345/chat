import SwiftUI
import Observation
import UIKit

/// Глобальное состояние приложения CentyChat (MV-паттерн с @Observable)
@Observable
@MainActor
public final class AppState {
    // MARK: - Navigation & Auth Flow
    
    public var isServerConfigured: Bool = false
    public var isAuthenticated: Bool = false
    public var mustChangePasswordRequired: Bool = false
    public var isLoading: Bool = false
    public var errorMessage: String? = nil
    
    // MARK: - Entities
    
    public var currentUser: User? = nil
    public var serverInfo: ServerInfo = ServerInfo()
    public var directConversations: [DirectConversation] = []
    public var channels: [Channel] = []
    public var announcements: [Announcement] = []
    public var users: [PublicUser] = []
    
    // MARK: - VoIP Call State
    
    public var activeCall: CallSession? = nil
    private var callTimer: Task<Void, Never>?
    private var audioRelay: AudioCallRelay?
    private var incomingAudioTask: Task<Void, Never>?
    public var callAudioError: String? = nil
    public var callAudioRequiresMicrophonePermission = false
    private let audioRelayFactory: @MainActor (Int64) -> AudioCallRelay
    
    // MARK: - Wake Buzzer & Presence
    
    public var wakeCooldownRemaining: Int = 0
    private var wakeCooldownTimer: Task<Void, Never>?
    public var incomingWakeAlert: String? = nil
    
    // MARK: - Typing Tracking
    
    public var typingUsers: [String: String] = [:] // key: "\(convType)_\(targetId)" -> "Алия печатает..."
    private var typingResetTimers: [String: Task<Void, Never>] = [:]
    
    // MARK: - Initialization & Lifecycle
    
    public convenience init() {
        self.init(audioRelayFactory: AppState.makeProductionAudioRelay)
    }

    init(audioRelayFactory: @escaping @MainActor (Int64) -> AudioCallRelay) {
        self.audioRelayFactory = audioRelayFactory
    }

    /// Production relay: AVAudioEngine capture with frames sent over the shared WebSocket.
    private static func makeProductionAudioRelay(peerId: Int64) -> AudioCallRelay {
        AudioCallRelay(
            targetUserId: peerId,
            backend: AVAudioEngineBackend(),
            sendFrame: { frame in
                Task {
                    await WebSocketClient.shared.sendAudioFrame(frame)
                }
            }
        )
    }
    
    public func initialize() async {
        isLoading = true
        defer { isLoading = false }
        
        let serverUrl = KeychainManager.shared.serverUrl
        guard !serverUrl.isEmpty else {
            isServerConfigured = false
            isAuthenticated = false
            return
        }
        isServerConfigured = true
        
        // 1. Проверяем доступность сервера
        do {
            let health = try await APIClient.shared.checkHealth()
            guard health.isHealthy else {
                errorMessage = "Сервер временно недоступен"
                return
            }
            let info = try await APIClient.shared.getServerInfo()
            self.serverInfo = info
        } catch {
            print("[AppState] Server health check failed: \(error)")
        }
        
        // 2. Если есть токен — запрашиваем профиль
        if let _ = KeychainManager.shared.authToken {
            do {
                let user = try await APIClient.shared.getCurrentUser()
                self.currentUser = user
                self.isAuthenticated = true
                self.mustChangePasswordRequired = user.mustChangePassword
                
                await WebSocketClient.shared.connect()
                await loadAllData()
            } catch APIError.mustChangePassword(let msg) {
                self.isAuthenticated = true
                self.mustChangePasswordRequired = true
                self.errorMessage = msg
            } catch APIError.unauthorized {
                do {
                    try KeychainManager.shared.clearAllAuthData()
                } catch {
                    self.errorMessage = error.localizedDescription
                }
                self.isAuthenticated = false
            } catch {
                print("[AppState] Session validation failed: \(error)")
                self.isAuthenticated = false
            }
        } else {
            // Пытаемся выполнить Device Knock
            await performDeviceKnock()
        }
        
        // 3. Запускаем прослушивание WebSocket событий
        startListeningWebSocketEvents()
        startListeningIncomingAudio()
    }
    
    // MARK: - Device Knock
    
    public func performDeviceKnock() async {
        do {
            let req = KnockRequest(
                deviceId: try KeychainManager.shared.deviceID(),
                deviceSecret: KeychainManager.shared.deviceSecret,
                deviceName: UIDevice.current.name,
                platform: "iOS \(UIDevice.current.systemVersion)"
            )
            let knockRes = try await APIClient.shared.knock(request: req)
            switch knockRes.status {
            case .paired:
                if let token = knockRes.token, let user = knockRes.user {
                    try KeychainManager.shared.saveAuthToken(token)
                    self.currentUser = user
                    self.isAuthenticated = true
                    self.mustChangePasswordRequired = user.mustChangePassword
                    await WebSocketClient.shared.connect()
                    await loadAllData()
                }
            case .loginRequired, .pending, .tooManyPending:
                self.isAuthenticated = false
            }
        } catch {
            print("[AppState] Knock error: \(error)")
        }
    }
    
    // MARK: - Data Loading
    
    public func loadAllData() async {
        async let directReq = APIClient.shared.getDirectConversations()
        async let channelsReq = APIClient.shared.getChannels()
        async let annReq = APIClient.shared.getAnnouncements()
        async let usersReq = APIClient.shared.getUsers()
        
        do {
            let (directs, chs, anns, usrs) = try await (directReq, channelsReq, annReq, usersReq)
            self.directConversations = directs
            self.channels = chs
            self.announcements = anns
            self.users = usrs
        } catch {
            print("[AppState] Error loading data: \(error)")
        }
    }
    
    // MARK: - WebSocket Event Listener
    
    private func startListeningWebSocketEvents() {
        Task { [weak self] in
            let eventStream = await WebSocketClient.shared.events
            for await event in eventStream {
                guard let self = self else { break }
                self.handleWebSocketEvent(event)
            }
        }
    }

    private func startListeningIncomingAudio() {
        incomingAudioTask?.cancel()
        incomingAudioTask = Task { [weak self] in
            let audioStream = await WebSocketClient.shared.incomingAudio
            for await frame in audioStream {
                guard !Task.isCancelled else { return }
                self?.audioRelay?.receive(frame)
            }
        }
    }
    
    public func handleWebSocketEvent(_ event: WSServerEvent) {
        switch event {
        case .authSuccess(let user):
            self.currentUser = user
            self.isAuthenticated = true
            Task { await self.loadAllData() }
            
        case .authError(let code, let msg):
            if code == "MUST_CHANGE_PASSWORD" {
                self.mustChangePasswordRequired = true
            } else {
                self.errorMessage = msg
            }
            
        case .wakeState(let _, let _, let retryAt):
            let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
            let diffSec = max(0, Int((retryAt - nowMs) / 1000))
            startWakeCooldown(seconds: diffSec)
            
        case .serverDisconnect(let reason):
            self.errorMessage = reason
            self.logout()
            
        case .newMessage(let message):
            handleIncomingMessage(message)
            
        case .messageStatusUpdated(let messageId, let status, _, _):
            updateMessageStatus(messageId: messageId, status: status)
            
        case .messagesRead(let byUserId, let messageIds):
            markMessagesAsRead(byUserId: byUserId, messageIds: messageIds)
            
        case .messageUpdated(let messageId, let text, let updatedAt):
            updateMessageContent(messageId: messageId, text: text, updatedAt: updatedAt)
            
        case .messageDeleted(let messageId, _, _):
            markMessageDeleted(messageId: messageId)
            
        case .userTyping(let userId, let userName, let convType, let targetId, let isTyping):
            handleTypingIndicator(userId: userId, userName: userName, convType: convType, targetId: targetId, isTyping: isTyping)
            
        case .userStatusChanged(let userId, let status, let customStatus):
            updateUserPresence(userId: userId, status: status, customStatus: customStatus)
            
        case .channelCreated(let channel):
            if !channels.contains(where: { $0.id == channel.id }) {
                channels.insert(channel, at: 0)
            }
            
        case .channelDeleted(let channelId):
            channels.removeAll { $0.id == channelId }
            
        case .newAnnouncement(let announcement):
            if !announcements.contains(where: { $0.id == announcement.id }) {
                announcements.insert(announcement, at: 0)
                CentyHaptics.warning()
            }
            
        case .announcementAcknowledged(let announcementId, let userId, _):
            if let aId = Int64(announcementId), let idx = announcements.firstIndex(where: { $0.id == aId }) {
                if userId == currentUser?.id {
                    announcements[idx].isConfirmed = true
                    announcements[idx].confirmedAt = Date()
                }
            }
            
        case .callOffer(let _, let senderId, let senderName):
            guard activeCall == nil else { return }
            activeCall = CallSession(
                peerId: senderId,
                peerName: senderName,
                state: .ringing,
                direction: .incoming
            )
            CentyHaptics.warning()
            
        case .callAnswer(let _, let senderId, _):
            guard activeCall?.peerId == senderId,
                  activeCall?.direction == .outgoing,
                  activeCall?.state == .calling else {
                return
            }
            activeCall?.state = .connecting
            Task { [weak self] in
                await self?.activateAcceptedOutgoingCall(for: senderId)
            }
            
        case .callRejected(let _, let senderId, _, let reason):
            if activeCall?.peerId == senderId {
                activeCall?.state = .failed
                activeCall?.endReason = .rejected
                stopCallSession(delay: 2.0)
            }
            
        case .callEnd(let _, let senderId, _, let reason):
            if activeCall?.peerId == senderId {
                activeCall?.state = .ended
                activeCall?.endReason = .normal
                stopCallSession(delay: 1.0)
            }
            
        case .callDenied(let reason):
            activeCall?.state = .failed
            activeCall?.endReason = .denied
            stopCallSession(delay: 2.5)
            
        case .callUnavailable(let _, let reason):
            activeCall?.state = .failed
            activeCall?.endReason = .unavailable
            stopCallSession(delay: 2.5)
            
        case .wakeRing(let fromUserId, let fromName, _):
            CentyHaptics.wakeBuzzer()
            incomingWakeAlert = "Вас вызывает: \(fromName)"
            
        case .wakeSent(let _, let _, let retryAt):
            let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
            let diffSec = max(0, Int((retryAt - nowMs) / 1000))
            startWakeCooldown(seconds: max(60, diffSec))
            
        case .wakeError(let code, let msg):
            errorMessage = msg ?? "Ошибка побудки: \(code)"
            
        case .serverError(_, let msg, _):
            if let msg = msg {
                errorMessage = msg
            }
            
        default:
            break
        }
    }
    
    // MARK: - Incoming Message Handler
    
    private func handleIncomingMessage(_ message: Message) {
        if message.conversationType == .direct {
            let partnerId = (message.senderId == currentUser?.id) ? message.targetId : message.senderId
            if let idx = directConversations.firstIndex(where: { $0.userId == partnerId }) {
                directConversations[idx].lastMessageId = message.id
                directConversations[idx].lastMessageText = message.text
                directConversations[idx].lastMessageTime = message.createdAt
                directConversations[idx].lastMessageSenderId = message.senderId
                directConversations[idx].lastMessageType = message.type
                if message.senderId != currentUser?.id {
                    directConversations[idx].unreadCount += 1
                }
                let updated = directConversations.remove(at: idx)
                directConversations.insert(updated, at: 0)
            } else {
                Task { await self.loadAllData() }
            }
        } else {
            if let idx = channels.firstIndex(where: { $0.id == message.targetId }) {
                channels[idx].lastMessageText = message.text
                channels[idx].lastMessageTime = message.createdAt
                if message.senderId != currentUser?.id {
                    channels[idx].unreadCount += 1
                }
                let updated = channels.remove(at: idx)
                channels.insert(updated, at: 0)
            }
        }
    }
    
    private func updateMessageStatus(messageId: Int64, status: DeliveryStatus) {
        // Broadcasts to active chat view model
    }
    
    private func markMessagesAsRead(byUserId: Int64, messageIds: [Int64]) {
        if let idx = directConversations.firstIndex(where: { $0.userId == byUserId }) {
            directConversations[idx].unreadCount = 0
        }
    }
    
    private func updateMessageContent(messageId: Int64, text: String, updatedAt: Date?) {
        // Will be reflected in chat detail view
    }
    
    private func markMessageDeleted(messageId: Int64) {
        // Will be reflected in chat detail view
    }
    
    private func handleTypingIndicator(userId: Int64, userName: String, convType: ConversationType, targetId: Int64, isTyping: Bool) {
        let key = "\(convType.rawValue)_\(targetId)"
        if isTyping {
            typingUsers[key] = "\(userName) печатает..."
            
            // Автосброс через 3 секунды
            typingResetTimers[key]?.cancel()
            typingResetTimers[key] = Task {
                try? await Task.sleep(nanoseconds: 3 * 1_000_000_000)
                guard !Task.isCancelled else { return }
                self.typingUsers.removeValue(forKey: key)
            }
        } else {
            typingResetTimers[key]?.cancel()
            typingUsers.removeValue(forKey: key)
        }
    }
    
    private func updateUserPresence(userId: Int64, status: UserStatus, customStatus: String?) {
        if let idx = users.firstIndex(where: { $0.id == userId }) {
            users[idx].status = status
            users[idx].customStatus = customStatus
        }
        if let idx = directConversations.firstIndex(where: { $0.userId == userId }) {
            directConversations[idx].status = status
            directConversations[idx].customStatus = customStatus
        }
    }
    
    // MARK: - Wake Cooldown
    
    public func sendWake(targetUserId: Int64) async {
        guard wakeCooldownRemaining == 0 else { return }
        await WebSocketClient.shared.send(clientMessage: .wakeSend(targetUserId: targetUserId))
        startWakeCooldown(seconds: 60)
        CentyHaptics.medium()
    }
    
    private func startWakeCooldown(seconds: Int) {
        wakeCooldownRemaining = seconds
        wakeCooldownTimer?.cancel()
        wakeCooldownTimer = Task {
            while self.wakeCooldownRemaining > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                self.wakeCooldownRemaining -= 1
            }
        }
    }
    
    // MARK: - Call Control
    
    public func startOutgoingCall(targetUser: PublicUser) async {
        guard activeCall == nil else { return }
        callAudioError = nil
        callAudioRequiresMicrophonePermission = false
        let call = CallSession(
            peerId: targetUser.id,
            peerName: targetUser.fullName,
            peerAvatar: targetUser.avatarUrl,
            state: .calling,
            direction: .outgoing
        )
        activeCall = call
        await WebSocketClient.shared.send(clientMessage: .callOffer(targetUserId: targetUser.id))
        
        // Таймаут вызова 45 секунд
        Task { [weak self, callID = call.id] in
            try? await Task.sleep(nanoseconds: 45 * 1_000_000_000)
            guard let self,
                  !Task.isCancelled,
                  self.activeCall?.id == callID,
                  self.activeCall?.state == .calling else {
                return
            }
            self.activeCall?.state = .failed
            self.activeCall?.endReason = .timeout
            self.stopCallSession(delay: 2.0)
        }
    }
    
    public func answerIncomingCall() async {
        guard let call = activeCall,
              call.direction == .incoming,
              call.state == .ringing else {
            return
        }
        activeCall?.state = .connecting
        let startResult = await prepareAudioRelay(for: call.peerId)
        guard isConnectingCall(with: call.peerId, direction: .incoming) else {
            discardAudioRelay(for: call.peerId)
            return
        }
        guard startResult == .started else {
            guard startResult != .cancelled else { return }
            await WebSocketClient.shared.send(
                clientMessage: .callRejected(
                    targetUserId: call.peerId,
                    reason: callAudioError ?? "Unable to start call audio"
                )
            )
            finishAudioStartupFailure(for: call.peerId)
            return
        }
        await WebSocketClient.shared.send(clientMessage: .callAnswer(targetUserId: call.peerId))
        guard isConnectingCall(with: call.peerId, direction: .incoming) else {
            discardAudioRelay(for: call.peerId)
            return
        }
        activateConnectedCall()
    }
    
    public func rejectIncomingCall(reason: String = "Занят") async {
        guard let call = activeCall else { return }
        await WebSocketClient.shared.send(clientMessage: .callRejected(targetUserId: call.peerId, reason: reason))
        stopCallSession(delay: 0)
    }
    
    public func endCall(reason: String = "Разговор завершен") async {
        guard let call = activeCall else { return }
        await WebSocketClient.shared.send(clientMessage: .callEnd(targetUserId: call.peerId, reason: reason))
        stopCallSession(delay: 0)
    }
    
    func activateAcceptedOutgoingCall(for peerId: Int64) async {
        guard let call = activeCall,
              call.peerId == peerId,
              call.direction == .outgoing,
              call.state == .calling || call.state == .connecting else {
            return
        }
        activeCall?.state = .connecting
        let startResult = await prepareAudioRelay(for: peerId)
        guard isConnectingCall(with: peerId, direction: .outgoing) else {
            discardAudioRelay(for: peerId)
            return
        }
        guard startResult == .started else {
            guard startResult != .cancelled else { return }
            await WebSocketClient.shared.send(
                clientMessage: .callEnd(
                    targetUserId: peerId,
                    reason: callAudioError ?? "Unable to start call audio"
                )
            )
            finishAudioStartupFailure(for: peerId)
            return
        }
        activateConnectedCall()
    }

    private func activateConnectedCall() {
        activeCall?.state = .active
        activeCall?.startedAt = Date()
        startCallTimer()
    }

    private func isConnectingCall(with peerId: Int64, direction: CallDirection) -> Bool {
        activeCall?.peerId == peerId &&
        activeCall?.direction == direction &&
        activeCall?.state == .connecting
    }

    private func finishAudioStartupFailure(for peerId: Int64) {
        guard activeCall?.peerId == peerId,
              activeCall?.state == .connecting else {
            return
        }
        activeCall?.state = .failed
        activeCall?.endReason = callAudioRequiresMicrophonePermission ? .micPermissionDenied : .connectionLost
        stopCallSession(delay: 2.0, retainingAudioError: true)
    }

    private func startCallTimer() {
        callTimer?.cancel()
        callTimer = Task {
            while self.activeCall?.state == .active {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let started = self.activeCall?.startedAt else { return }
                self.activeCall?.duration = Date().timeIntervalSince(started)
            }
        }
    }
    
    public func stopCallSession(delay: TimeInterval = 0, retainingAudioError: Bool = false) {
        callTimer?.cancel()
        callTimer = nil
        audioRelay?.stop()
        audioRelay = nil
        if !retainingAudioError {
            callAudioError = nil
            callAudioRequiresMicrophonePermission = false
        }
        
        if delay > 0 {
            let endingCallID = activeCall?.id
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self,
                      !Task.isCancelled,
                      self.activeCall?.id == endingCallID else {
                    return
                }
                self.activeCall = nil
                self.callAudioError = nil
                self.callAudioRequiresMicrophonePermission = false
            }
        } else {
            activeCall = nil
        }
    }
    
    public func toggleMute() {
        guard activeCall?.state == .active else { return }
        activeCall?.isMuted.toggle()
        if let isMuted = activeCall?.isMuted {
            audioRelay?.setMuted(isMuted)
        }
        CentyHaptics.light()
    }
    
    public func toggleSpeaker() {
        guard activeCall?.state == .active else { return }
        guard let current = activeCall?.isSpeakerOn else { return }
        let newState = !current
        activeCall?.isSpeakerOn = newState
        AudioSessionManager.shared.setSpeaker(enabled: newState)
        CentyHaptics.light()
    }

    public func retryAudioForActiveCall() async {
        guard let call = activeCall,
              call.state == .active || call.state == .connecting else {
            return
        }
        let callStateBeforeRetry = call.state
        let startResult = await prepareAudioRelay(for: call.peerId)
        guard activeCall?.id == call.id,
              activeCall?.state == callStateBeforeRetry else {
            discardAudioRelay(for: call.peerId)
            return
        }
        guard startResult == .started else { return }
        if callStateBeforeRetry == .connecting {
            activateConnectedCall()
        }
    }

    private func prepareAudioRelay(for peerId: Int64) async -> AudioRelayStartResult {
        if let existing = audioRelay,
           existing.targetUserId == peerId,
           existing.state == .active {
            return .started
        }

        audioRelay?.stop()
        let relay = audioRelayFactory(peerId)
        audioRelay = relay
        relay.onStateChange = { [weak self] state in
            guard case .failed = state else { return }
            self?.setCallAudioError("Audio connection was interrupted. Check the microphone and try again.")
        }
        relay.onRecoveryRequired = { [weak self] _ in
            self?.setCallAudioError("Audio was interrupted. Try the call again when the audio route is available.")
        }

        switch await relay.start() {
        case .started:
            guard audioRelay === relay else {
                relay.stop()
                return .cancelled
            }
            callAudioError = nil
            callAudioRequiresMicrophonePermission = false
            if activeCall?.isMuted == true {
                relay.setMuted(true)
            }
            return .started
        case .microphonePermissionDenied:
            if audioRelay === relay {
                audioRelay = nil
            }
            setCallAudioError("Microphone access is required to start a call.")
            callAudioRequiresMicrophonePermission = true
            return .microphonePermissionDenied
        case .unavailable:
            if audioRelay === relay {
                audioRelay = nil
            }
            setCallAudioError("Unable to start audio. Check your audio route and try again.")
            callAudioRequiresMicrophonePermission = false
            return .unavailable
        case .cancelled:
            if audioRelay === relay {
                audioRelay = nil
            }
            return .cancelled
        }
    }

    private func discardAudioRelay(for peerId: Int64) {
        guard let relay = audioRelay, relay.targetUserId == peerId else { return }
        relay.stop()
        audioRelay = nil
    }

    private func setCallAudioError(_ message: String) {
        callAudioError = message
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    // MARK: - Logout
    
    public func logout() {
        Task {
            await logout(using: APIClient.shared)
        }
    }

    func logout(using client: APIClient) async {
        do {
            try await client.logout()
            await WebSocketClient.shared.disconnect()
            handleLogoutOutcome(nil)
        } catch {
            handleLogoutOutcome(error)
        }
    }

    func handleLogoutOutcome(_ error: (any Error)?) {
        if let error {
            errorMessage = error.localizedDescription
            return
        }

        currentUser = nil
        isAuthenticated = false
        directConversations = []
        channels = []
        announcements = []
        users = []
        incomingAudioTask?.cancel()
        incomingAudioTask = nil
        stopCallSession()
    }
}
