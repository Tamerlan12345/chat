import Foundation
import Observation
import UIKit

/// One-to-one voice calls over the WebSocket audio relay.
@Observable
@MainActor
public final class CallStore: RealtimeEventHandling {
    public var activeCall: CallSession?
    public private(set) var callAudioError: String?
    public private(set) var callAudioRequiresMicrophonePermission = false

    @ObservationIgnored private let realtime: RealtimeStore
    @ObservationIgnored private let audioRelayFactory: @MainActor (Int64) -> AudioCallRelay
    @ObservationIgnored private var callTimer: Task<Void, Never>?
    @ObservationIgnored private var audioRelay: AudioCallRelay?

    init(realtime: RealtimeStore, audioRelayFactory: @escaping @MainActor (Int64) -> AudioCallRelay) {
        self.realtime = realtime
        self.audioRelayFactory = audioRelayFactory
    }

    /// Production relay: AVAudioEngine capture with frames sent over the realtime connection.
    static func makeProductionAudioRelay(
        repository: any RealtimeRepository
    ) -> @MainActor (Int64) -> AudioCallRelay {
        { peerId in
            AudioCallRelay(
                targetUserId: peerId,
                backend: AVAudioEngineBackend(),
                sendFrame: { frame in
                    Task {
                        await repository.sendAudioFrame(frame)
                    }
                }
            )
        }
    }

    /// Feeds one decoded frame from the peer into the active relay.
    func receiveAudio(_ frame: AudioRelayEngine.DecodedAudioFrame) {
        audioRelay?.receive(frame)
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .callOffer(_, let senderId, let senderName):
            guard activeCall == nil else { return }
            activeCall = CallSession(
                peerId: senderId,
                peerName: senderName,
                state: .ringing,
                direction: .incoming
            )
            CentyHaptics.warning()

        case .callAnswer(_, let senderId, _):
            guard activeCall?.peerId == senderId,
                  activeCall?.direction == .outgoing,
                  activeCall?.state == .calling else {
                return
            }
            activeCall?.state = .connecting
            Task { [weak self] in
                await self?.activateAcceptedOutgoingCall(for: senderId)
            }

        case .callRejected(_, let senderId, _, _):
            if activeCall?.peerId == senderId {
                activeCall?.state = .failed
                activeCall?.endReason = .rejected
                stopCallSession(delay: 2.0)
            }

        case .callEnd(_, let senderId, _, _):
            if activeCall?.peerId == senderId {
                activeCall?.state = .ended
                activeCall?.endReason = .normal
                stopCallSession(delay: 1.0)
            }

        case .callDenied:
            activeCall?.state = .failed
            activeCall?.endReason = .denied
            stopCallSession(delay: 2.5)

        case .callUnavailable:
            activeCall?.state = .failed
            activeCall?.endReason = .unavailable
            stopCallSession(delay: 2.5)

        default:
            break
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
        await realtime.send(.callOffer(targetUserId: targetUser.id))

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
            await realtime.send(.callRejected(
                targetUserId: call.peerId,
                reason: callAudioError ?? Self.audioStartFailureReason
            ))
            finishAudioStartupFailure(for: call.peerId)
            return
        }
        await realtime.send(.callAnswer(targetUserId: call.peerId))
        guard isConnectingCall(with: call.peerId, direction: .incoming) else {
            discardAudioRelay(for: call.peerId)
            return
        }
        activateConnectedCall()
    }

    public func rejectIncomingCall(reason: String = String(localized: "Занят")) async {
        guard let call = activeCall else { return }
        await realtime.send(.callRejected(targetUserId: call.peerId, reason: reason))
        stopCallSession(delay: 0)
    }

    public func endCall(reason: String = String(localized: "Разговор завершен")) async {
        guard let call = activeCall else { return }
        await realtime.send(.callEnd(targetUserId: call.peerId, reason: reason))
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
            await realtime.send(.callEnd(
                targetUserId: peerId,
                reason: callAudioError ?? Self.audioStartFailureReason
            ))
            finishAudioStartupFailure(for: peerId)
            return
        }
        activateConnectedCall()
    }

    private static var audioStartFailureReason: String {
        String(localized: "Не удалось запустить звук звонка")
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
        callTimer = Task { [weak self] in
            while let self, self.activeCall?.state == .active {
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
            self?.setCallAudioError(String(localized: "Аудиосвязь прервалась. Проверьте микрофон и попробуйте снова."))
        }
        relay.onRecoveryRequired = { [weak self] _ in
            self?.setCallAudioError(String(localized: "Звук прерван. Повторите звонок, когда аудиоустройство станет доступно."))
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
            setCallAudioError(String(localized: "Для звонка нужен доступ к микрофону."))
            callAudioRequiresMicrophonePermission = true
            return .microphonePermissionDenied
        case .unavailable:
            if audioRelay === relay {
                audioRelay = nil
            }
            setCallAudioError(String(localized: "Не удалось включить звук. Проверьте аудиоустройство и попробуйте снова."))
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
}
