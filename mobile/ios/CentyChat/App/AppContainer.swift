import Foundation
import Observation
import SwiftUI

/// Composition root: builds the repositories and feature stores and wires
/// realtime events and session lifecycle between them.
@Observable
@MainActor
public final class AppContainer: SessionLifecycleDelegate {
    public let session: SessionStore
    public let realtime: RealtimeStore
    public let conversations: ConversationsStore
    public let announcements: AnnouncementsStore
    public let calls: CallStore
    public let profile: ProfileStore
    public let chats: ChatRegistry

    @ObservationIgnored private let chatRepository: any ChatRepository
    @ObservationIgnored private let announcementsRepository: any AnnouncementsRepository

    init(
        server: any ServerRepository,
        auth: any AuthRepository,
        chat: any ChatRepository,
        announcements announcementsRepository: any AnnouncementsRepository,
        realtime realtimeRepository: any RealtimeRepository,
        audioRelayFactory: (@MainActor (Int64) -> AudioCallRelay)? = nil,
        deviceDescriptor: @escaping @MainActor () -> DeviceDescriptor = SessionStore.currentDevice
    ) {
        self.chatRepository = chat
        self.announcementsRepository = announcementsRepository

        let realtime = RealtimeStore(repository: realtimeRepository)
        let session = SessionStore(auth: auth, server: server, realtime: realtime, deviceDescriptor: deviceDescriptor)
        let conversations = ConversationsStore(repository: chat, session: session)
        let announcements = AnnouncementsStore(repository: announcementsRepository, session: session)
        let calls = CallStore(
            realtime: realtime,
            audioRelayFactory: audioRelayFactory ?? CallStore.makeProductionAudioRelay(repository: realtimeRepository)
        )
        let profile = ProfileStore(realtime: realtime, session: session)
        let chats = ChatRegistry { conversation in
            ChatStore(
                conversation: conversation,
                repository: chat,
                realtime: realtime,
                session: session,
                conversations: conversations
            )
        }

        self.realtime = realtime
        self.session = session
        self.conversations = conversations
        self.announcements = announcements
        self.calls = calls
        self.profile = profile
        self.chats = chats

        session.delegate = self
        realtime.register(session)
        realtime.register(conversations)
        realtime.register(chats)
        realtime.register(announcements)
        realtime.register(calls)
        realtime.register(profile)
        realtime.audioSink = { [weak calls] frame in
            calls?.receiveAudio(frame)
        }
        conversations.onNeedsReload = { [weak self] in
            Task { await self?.loadAllData() }
        }
    }

    /// Production wiring over the shared network clients.
    public static func live() -> AppContainer {
        let client = APIClient.shared
        let keychain = KeychainManager.shared
        return AppContainer(
            server: LiveServerRepository(client: client, keychain: keychain),
            auth: LiveAuthRepository(client: client, keychain: keychain),
            chat: LiveChatRepository(client: client),
            announcements: LiveAnnouncementsRepository(client: client),
            realtime: LiveRealtimeRepository(client: WebSocketClient.shared)
        )
    }

    // MARK: - Data

    public func loadAllData() async {
        async let directRequest = chatRepository.directConversations()
        async let channelsRequest = chatRepository.channels()
        async let announcementsRequest = announcementsRepository.announcements()
        async let usersRequest = chatRepository.users()

        do {
            let (directs, channels, announcementItems, users) = try await (
                directRequest, channelsRequest, announcementsRequest, usersRequest
            )
            conversations.directConversations = directs
            conversations.channels = channels
            announcements.announcements = announcementItems
            conversations.users = users
        } catch {
            Log.session.error("Loading data failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - SessionLifecycleDelegate

    func sessionNeedsDataReload() async {
        await loadAllData()
    }

    func sessionDidEnd() {
        conversations.reset()
        announcements.reset()
        chats.reset()
        profile.reset()
        calls.stopCallSession()
    }
}

extension View {
    /// Injects the container and every feature store into the environment.
    func appEnvironment(_ container: AppContainer) -> some View {
        self
            .environment(container)
            .environment(container.session)
            .environment(container.realtime)
            .environment(container.conversations)
            .environment(container.announcements)
            .environment(container.calls)
            .environment(container.profile)
    }
}
