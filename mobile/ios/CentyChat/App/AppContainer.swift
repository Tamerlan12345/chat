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
    public let presence: PresenceController
    public let notifications: MessageNotificationsStore
    public let account: AccountStore
    /// The colleague directory of the session («Сотрудники», search, person cards).
    public let people: PeopleStore
    /// «Недавние» of the search in «Чаты».
    public let searchRecents: SearchRecentsStore
    /// This device's APNs token on the server (`push.md` §2).
    let pushTokens: PushTokenRegistrar
    /// Colleagues' photos, cached on disk; wiped when the session ends.
    let avatars: AvatarImageLoader
    let accountRepository: any AccountRepository

    init(
        server: any ServerRepository,
        auth: any AuthRepository,
        chat: any ChatRepository,
        announcements announcementsRepository: any AnnouncementsRepository,
        realtime realtimeRepository: any RealtimeRepository,
        environment: ServerEnvironment,
        audioRelayFactory: (@MainActor (Int64) -> AudioCallRelay)? = nil,
        deviceDescriptor: @escaping @MainActor () -> DeviceDescriptor = SessionStore.currentDevice,
        handshake: RealtimeHandshakeState = RealtimeHandshakeState(deviceId: { nil }),
        startsInBackground: Bool = false,
        notificationCenter: any LocalNotificationCenter = SilentNotificationCenter(),
        accountRepository: any AccountRepository = UnavailableAccountRepository(),
        peopleSource: (any PeopleSource)? = nil,
        peopleCache: (any PeopleCache)? = nil,
        recentsDefaults: UserDefaults? = nil,
        pushTokenService: (any PushTokenService)? = nil,
        deviceId: @escaping @MainActor () -> String? = { nil },
        avatarLoader: AvatarImageLoader? = nil
    ) {
        let realtime = RealtimeStore(repository: realtimeRepository)
        let session = SessionStore(
            auth: auth,
            server: server,
            realtime: realtime,
            environment: environment,
            deviceDescriptor: deviceDescriptor
        )
        let conversations = ConversationsStore(repository: chat, session: session)
        let announcements = AnnouncementsStore(repository: announcementsRepository, session: session)
        let calls = CallStore(
            realtime: realtime,
            audioRelayFactory: audioRelayFactory ?? CallStore.makeProductionAudioRelay(repository: realtimeRepository)
        )
        let presence = PresenceController(
            realtime: realtime,
            handshake: handshake,
            startsInBackground: startsInBackground,
            currentUserId: { [weak session] in session?.currentUser?.id }
        )
        let profile = ProfileStore(realtime: realtime, session: session, presence: presence)
        let notifications = MessageNotificationsStore(
            center: notificationCenter,
            session: session,
            conversations: conversations,
            presence: presence
        )
        let account = AccountStore(repository: accountRepository, session: session)
        let chats = ChatRegistry { conversation in
            ChatStore(
                conversation: conversation,
                repository: chat,
                realtime: realtime,
                session: session,
                conversations: conversations,
                presenceController: presence
            )
        }

        self.realtime = realtime
        self.session = session
        self.conversations = conversations
        self.announcements = announcements
        self.calls = calls
        self.profile = profile
        self.chats = chats
        self.presence = presence
        self.notifications = notifications
        self.account = account
        self.people = PeopleStore(
            source: peopleSource ?? UnavailablePeopleSource(),
            cache: peopleCache ?? InMemoryPeopleCache(),
            ownerId: { [weak session] in session?.currentUser?.id }
        )
        self.searchRecents = SearchRecentsStore(defaults: recentsDefaults)
        self.pushTokens = PushTokenRegistrar(
            service: pushTokenService ?? DisabledPushTokenService(),
            deviceId: deviceId,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            environment: .current
        )
        self.avatars = avatarLoader ?? AvatarImageLoader.inMemory(serverURL: environment.serverURL)
        self.accountRepository = accountRepository

        account.onBlocksChanged = { [weak conversations, weak chats] in
            await conversations?.loadDirectConversations()
            await chats?.reloadLoaded()
        }
        session.delegate = self
        realtime.register(session)
        realtime.register(presence)
        realtime.register(conversations)
        realtime.register(chats)
        realtime.register(announcements)
        realtime.register(calls)
        realtime.register(profile)
        realtime.register(notifications)
        realtime.register(people)
        realtime.audioSink = { [weak calls] frame in
            calls?.receiveAudio(frame)
        }
    }

    /// Production wiring over the shared network clients and the build's fixed server.
    public static func live() -> AppContainer {
        let client = APIClient.shared
        let keychain = KeychainManager.shared
        let accountRepository: any AccountRepository
#if DEBUG
        if LaunchTestFixture.stubsAccountBackend {
            accountRepository = UITestAccountRepository(client: client, keychain: keychain)
        } else {
            accountRepository = LiveAccountRepository(client: client, keychain: keychain)
        }
#else
        accountRepository = LiveAccountRepository(client: client, keychain: keychain)
#endif
        return AppContainer(
            server: LiveServerRepository(client: client),
            auth: LiveAuthRepository(client: client, keychain: keychain),
            chat: LiveChatRepository(client: client),
            announcements: LiveAnnouncementsRepository(client: client),
            realtime: LiveRealtimeRepository(client: WebSocketClient.shared),
            environment: .current,
            handshake: .shared,
            startsInBackground: UIApplication.shared.applicationState == .background,
            notificationCenter: UserNotificationCenterBridge(),
            accountRepository: accountRepository,
            peopleSource: APIPeopleSource(client: client),
            peopleCache: PeopleDiskCache(),
            recentsDefaults: .standard,
            pushTokenService: LivePushTokenService(client: client),
            deviceId: { try? keychain.deviceID() },
            avatarLoader: .live(keychain: keychain)
        )
    }

    // MARK: - Data

    /// Loads every list concurrently; each list keeps its own loading/error state,
    /// so one failing request does not empty the others.
    public func loadAllData() async {
        async let direct: Void = conversations.loadDirectConversations()
        async let channels: Void = conversations.loadChannels()
        async let users: Void = conversations.loadUsers()
        async let announcementItems: Void = announcements.load()
        async let blocks: Void = account.loadBlocks()
        _ = await (direct, channels, users, announcementItems, blocks)
    }

    // MARK: - SessionLifecycleDelegate

    func sessionDidAuthenticate() async {
        // After every sign-in and every launch with a live session (`push.md` §2).
        async let push: Void = pushTokens.sessionDidAuthenticate()
        await loadAllData()
        await push
    }

    func sessionDidResume() async {
        await loadAllData()
        await chats.reloadLoaded()
    }

    func sessionWillSignOut() async {
        await pushTokens.sessionWillSignOut()
    }

    func sessionDidEnd() {
        pushTokens.sessionDidEnd()
        // Colleagues' photos belong to the session that saw them.
        let avatars = avatars
        Task { await avatars.removeAll() }
        conversations.reset()
        announcements.reset()
        chats.reset()
        profile.reset()
        presence.reset()
        notifications.reset()
        account.reset()
        // The directory and the search recents belong to the account that signed out.
        people.signOut()
        searchRecents.clear()
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
            .environment(container.presence)
            .environment(container.notifications)
            .environment(container.account)
            .environment(\.avatarLoader, container.avatars)
    }
}
