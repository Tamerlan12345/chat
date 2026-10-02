import Foundation

/// What this device tells the server about itself (`multi-device.md` §2–§4): the automatic
/// presence of its socket and the chat open on screen. Pure state: every input returns the
/// frames to send, in order; the caller sends them and reports a frame that did not go out.
///
/// Rules (the owner's, same as Android `PresenceController` and the desktop):
/// - foreground → `online`, background → `away`; `.inactive` (control centre, a call sheet) changes nothing;
/// - nothing is sent until the lifecycle has reported once (no guess goes to the server);
/// - only a change is sent; after every `auth_success` the current state is sent again
///   (the server reset it), driven by the event itself, not by the connection state;
/// - `viewing` is sent only while online; going away clears it on the server by itself,
///   so coming back sends the open chat again.
public struct PresenceMachine: Equatable, Sendable {
    public enum Frame: Equatable, Sendable {
        case presence(PresenceState)
        case viewing(ConversationKey?)

        public var message: WSClientMessage {
            switch self {
            case .presence(let state): .presence(state: state.rawValue, customStatus: nil)
            case .viewing(let conversation): .viewing(conversation)
            }
        }
    }

    /// What the server holds for this socket's `viewing`.
    enum ServerViewing: Equatable, Sendable {
        case unknown
        case known(ConversationKey?)
    }

    public private(set) var presence: PresenceState
    /// The lifecycle has reported at least once.
    public private(set) var isKnown = false
    /// The chat screen on display, whatever the app state.
    public private(set) var openChat: ConversationKey?

    private var sentPresence: PresenceState?
    private var sentViewing: ServerViewing = .unknown

    public init(presence: PresenceState = .online) {
        self.presence = presence
    }

    /// The chat the server should consider viewed: only in the foreground.
    public var viewing: ConversationKey? {
        presence == .online ? openChat : nil
    }

    /// The device fields for the next `auth` frame.
    public func handshake(deviceId: String?) -> AuthHandshake {
        AuthHandshake(deviceId: deviceId, platform: "ios", presence: isKnown ? presence : .online, viewing: isKnown ? viewing : nil)
    }

    // MARK: - Inputs

    /// The app came to the foreground (`scenePhase == .active`).
    public mutating func foreground() -> [Frame] {
        set(.online)
    }

    /// The app went to the background (`scenePhase == .background`).
    public mutating func background() -> [Frame] {
        set(.away)
    }

    /// A chat screen is on display.
    public mutating func setViewing(_ conversation: ConversationKey) -> [Frame] {
        openChat = conversation
        return flush()
    }

    /// The chat screen went away. With a conversation, only that chat is cleared: a late
    /// disappear of the previous chat does not clear the one that is open now.
    public mutating func clearViewing(_ conversation: ConversationKey? = nil) -> [Frame] {
        if let conversation, conversation != openChat { return [] }
        openChat = nil
        return flush()
    }

    /// `auth_success`: the server forgot this socket's state; send the current one again.
    public mutating func authenticated() -> [Frame] {
        sentPresence = nil
        sentViewing = .unknown
        return flush()
    }

    /// A frame did not reach the server (no authenticated socket): it is sent again later.
    public mutating func sendFailed(_ frame: Frame) {
        switch frame {
        case .presence(let state):
            if sentPresence == state { sentPresence = nil }
        case .viewing(let conversation):
            if sentViewing == .known(conversation) { sentViewing = .unknown }
        }
    }

    // MARK: - Private

    private mutating func set(_ value: PresenceState) -> [Frame] {
        presence = value
        isKnown = true
        return flush()
    }

    private mutating func flush() -> [Frame] {
        guard isKnown else { return [] }
        var frames: [Frame] = []
        if sentPresence != presence {
            frames.append(.presence(presence))
            sentPresence = presence
            if presence == .away {
                // The server drops `viewing` of an away socket by itself.
                sentViewing = .known(nil)
            }
        }
        if presence == .online, sentViewing != .known(openChat) {
            frames.append(.viewing(openChat))
            sentViewing = .known(openChat)
        }
        return frames
    }
}

/// The device fields the realtime client reads for every `auth` frame. Written by the
/// main-actor `PresenceController`, read by the `WebSocketClient` actor at connect.
public final class RealtimeHandshakeState: @unchecked Sendable {
    public static let shared = RealtimeHandshakeState(deviceId: { try? KeychainManager.shared.deviceID() })

    private let lock = NSLock()
    private var presence: PresenceState = .online
    private var viewing: ConversationKey?
    private let deviceId: @Sendable () -> String?

    public init(deviceId: @escaping @Sendable () -> String?) {
        self.deviceId = deviceId
    }

    public func update(presence: PresenceState, viewing: ConversationKey?) {
        lock.lock()
        defer { lock.unlock() }
        self.presence = presence
        self.viewing = viewing
    }

    public func handshake() -> AuthHandshake {
        lock.lock()
        let presence = self.presence
        let viewing = self.viewing
        lock.unlock()
        return AuthHandshake(deviceId: deviceId(), platform: "ios", presence: presence, viewing: presence == .online ? viewing : nil)
    }
}
