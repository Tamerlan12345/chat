import Foundation
import Observation

/// The single realtime event pump: owns the WebSocket subscription and
/// fans server events out to the feature stores.
@Observable
@MainActor
public final class RealtimeStore {
    public private(set) var connectionState: RealtimeConnectionState = .disconnected

    @ObservationIgnored private let repository: any RealtimeRepository
    @ObservationIgnored private var handlers: [WeakRealtimeHandler] = []
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var audioTask: Task<Void, Never>?
    @ObservationIgnored private var stateTask: Task<Void, Never>?
    /// Receives decoded call audio frames.
    @ObservationIgnored var audioSink: (@MainActor (AudioRelayEngine.DecodedAudioFrame) -> Void)?

    init(repository: any RealtimeRepository) {
        self.repository = repository
    }

    func register(_ handler: any RealtimeEventHandling) {
        handlers.append(WeakRealtimeHandler(handler))
    }

    // MARK: - Connection

    func connect() async {
        await repository.connect()
    }

    func disconnect() async {
        await repository.disconnect()
    }

    func startListening() async {
        let events = await repository.events()
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                self.dispatch(event)
            }
        }

        let states = await repository.connectionStates()
        stateTask?.cancel()
        stateTask = Task { [weak self] in
            for await state in states {
                self?.connectionState = state
            }
        }

        let audio = await repository.incomingAudio()
        audioTask?.cancel()
        audioTask = Task { [weak self] in
            for await frame in audio {
                guard !Task.isCancelled else { return }
                self?.audioSink?(frame)
            }
        }
    }

    func stopAudioListener() {
        audioTask?.cancel()
        audioTask = nil
    }

    // MARK: - Outgoing

    func send(_ message: WSClientMessage) async {
        await repository.send(message)
    }

    func sendAudioFrame(_ frame: Data) async {
        await repository.sendAudioFrame(frame)
    }

    // MARK: - Dispatch

    func dispatch(_ event: WSServerEvent) {
        handlers.removeAll { $0.value == nil }
        for handler in handlers {
            handler.value?.handle(event)
        }
    }
}
