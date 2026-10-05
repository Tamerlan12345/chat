import Foundation
import Observation

/// The single realtime event pump: owns the WebSocket subscription for the
/// authenticated session and fans server events out to the feature stores.
@Observable
@MainActor
public final class RealtimeStore {
    public private(set) var connectionState: RealtimeConnectionState = .disconnected
    public private(set) var isRunning = false

    @ObservationIgnored private let repository: any RealtimeRepository
    @ObservationIgnored private var handlers: [WeakRealtimeHandler] = []
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var audioTask: Task<Void, Never>?
    @ObservationIgnored private var stateTask: Task<Void, Never>?
    @ObservationIgnored private var frameTask: Task<Void, Never>?
    /// Receives every raw frame and every close, in order (the delivery engine).
    @ObservationIgnored var deliverySink: (@MainActor (DeliveryLinkFrame) -> Void)?
    @ObservationIgnored private var lifecycle = 0
    /// The server sends `new_message` together with `direct_message`/`channel_message`
    /// for the same message; each message id is delivered to the stores once.
    @ObservationIgnored private var deliveredMessageIDs = RecentIDs(capacity: 1_024)
    /// Receives decoded call audio frames.
    @ObservationIgnored var audioSink: (@MainActor (AudioRelayEngine.DecodedAudioFrame) -> Void)?

    init(repository: any RealtimeRepository) {
        self.repository = repository
    }

    func register(_ handler: any RealtimeEventHandling) {
        handlers.append(WeakRealtimeHandler(handler))
    }

    // MARK: - Lifecycle

    /// Subscribes to events, call audio and connection state, then connects. Idempotent.
    func start() async {
        guard !isRunning else { return }
        isRunning = true
        lifecycle += 1
        let generation = lifecycle

        let events = await repository.events()
        let states = await repository.connectionStates()
        let audio = await repository.incomingAudio()
        let frames = await repository.deliveryFrames()
        guard generation == lifecycle else { return }

        frameTask = Task { [weak self] in
            for await frame in frames {
                self?.deliverySink?(frame)
            }
        }

        eventTask = Task { [weak self] in
            for await event in events {
                self?.dispatch(event)
            }
        }
        stateTask = Task { [weak self] in
            for await state in states {
                self?.connectionState = state
            }
        }
        audioTask = Task { [weak self] in
            for await frame in audio {
                self?.audioSink?(frame)
            }
        }
        await repository.connect()
    }

    /// Closes the socket and ends all subscriptions.
    func stop() async {
        guard isRunning else { return }
        isRunning = false
        lifecycle += 1
        eventTask?.cancel()
        stateTask?.cancel()
        audioTask?.cancel()
        frameTask?.cancel()
        eventTask = nil
        stateTask = nil
        audioTask = nil
        frameTask = nil
        deliveredMessageIDs.removeAll()
        connectionState = .disconnected
        // The subscription is gone before the socket's own close could arrive.
        deliverySink?(.closed)
        await repository.disconnect()
    }

    /// A reconnect waiting for its backoff goes now (the network came back).
    func reconnectNow() async {
        guard isRunning else { return }
        await repository.reconnectNow()
    }

    /// Opens a fresh socket so it authenticates with the current token.
    func reconnect() async {
        await stop()
        await start()
    }

    // MARK: - Outgoing

    func send(_ message: WSClientMessage) async {
        await repository.send(message)
    }

    /// Sends only on an authenticated socket; false when the frame did not go out.
    func sendIfAuthenticated(_ message: WSClientMessage) async -> Bool {
        await repository.sendIfAuthenticated(message)
    }

    // MARK: - Dispatch

    func dispatch(_ event: WSServerEvent) {
        if case .newMessage(let message, _) = event, !deliveredMessageIDs.insert(message.id) {
            return
        }
        handlers.removeAll { $0.value == nil }
        for handler in handlers {
            handler.value?.handle(event)
        }
    }
}

/// A bounded set that remembers the most recent ids.
struct RecentIDs {
    let capacity: Int
    private var order: [Int64] = []
    private var members: Set<Int64> = []

    init(capacity: Int) {
        self.capacity = capacity
    }

    /// Returns false when the id was already seen.
    mutating func insert(_ id: Int64) -> Bool {
        guard members.insert(id).inserted else { return false }
        order.append(id)
        if order.count > capacity {
            members.remove(order.removeFirst())
        }
        return true
    }

    func contains(_ id: Int64) -> Bool {
        members.contains(id)
    }

    mutating func removeAll() {
        order.removeAll()
        members.removeAll()
    }
}
