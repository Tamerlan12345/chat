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
    /// The message queue (`delivery-state.md`), its files and its owner.
    let delivery: DeliveryRuntime
    /// Downloaded attachments in `Caches/Attachments`; wiped when the session ends.
    let downloads: AttachmentDownloader
    /// Image previews of attachments (memory only); wiped when the session ends.
    let thumbnails: AttachmentThumbnails
    private let networkPath = NetworkPathWatcher()

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
        avatarLoader: AvatarImageLoader? = nil,
        deliveryStore: any DeliveryStore = InMemoryDeliveryStore(),
        uploadStore: any PendingUploadStore = InMemoryPendingUploadStore(),
        deliveryBackend: any DeliveryBackend = UnavailableDeliveryBackend(),
        uploader: any AttachmentUploader = UnavailableAttachmentUploader(),
        downloadTransport: any DownloadTransport = UnavailableDownloadTransport(),
        attachmentFiles: AttachmentFiles = AttachmentFiles(root: FileManager.default.temporaryDirectory.appendingPathComponent("Outbox-\(UUID().uuidString)", isDirectory: true)),
        downloadsRoot: URL = FileManager.default.temporaryDirectory.appendingPathComponent("Attachments-\(UUID().uuidString)", isDirectory: true),
        deliveryClock: any DeliveryClock = SystemDeliveryClock(),
        thumbnails: AttachmentThumbnails? = nil
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
        let deliveryLog: @Sendable (String) -> Void = { line in Log.delivery.error("\(line, privacy: .public)") }
        let engine = DeliveryEngine(
            store: deliveryStore,
            link: RealtimeDeliveryLink(repository: realtimeRepository),
            backend: deliveryBackend,
            clock: deliveryClock,
            log: deliveryLog
        )
        let uploads = AttachmentUploads(
            store: uploadStore,
            files: attachmentFiles,
            uploader: uploader,
            engine: engine,
            clock: deliveryClock,
            owner: { [weak session] in session?.currentUser?.id },
            log: deliveryLog
        )
        let delivery = DeliveryRuntime(
            engine: engine,
            uploads: uploads,
            currentUser: { [weak session] in session?.currentUser?.id },
            reconnect: { [weak realtime] in await realtime?.reconnectNow() },
            clock: deliveryClock,
            log: deliveryLog
        )
        let chats = ChatRegistry { conversation in
            ChatStore(
                conversation: conversation,
                repository: chat,
                realtime: realtime,
                session: session,
                conversations: conversations,
                delivery: delivery,
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
        self.delivery = delivery
        self.downloads = AttachmentDownloader(root: downloadsRoot, transport: downloadTransport)
        self.thumbnails = thumbnails ?? AttachmentThumbnails(environment: environment, token: { nil }, live: false)

        // Every frame and close reaches the engine in order; its changes reach the open chats.
        realtime.deliverySink = { [weak engine] frame in engine?.receive(frame) }
        realtime.onConnectionStateChange = { [weak uploads] state in uploads?.setOnline(state == .connected) }
        engine.onStateChange.append { [weak chats] _ in chats?.modelChanged() }
        engine.onUserError.append { [weak chats] code in chats?.deliveryNotice(code: code) }
        uploads.onChange = { [weak chats] in chats?.modelChanged() }
        uploads.onNotice = { [weak chats] notice in chats?.uploadNotice(notice) }
        engine.start()
        uploads.start()

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
            avatarLoader: .live(keychain: keychain),
            deliveryStore: LiveDelivery.store,
            uploadStore: LiveDelivery.store,
            deliveryBackend: HTTPDeliveryBackend(client: client),
            uploader: APIAttachmentUploader(client: client),
            downloadTransport: URLSessionDownloadTransport(environment: .current, token: { keychain.authToken }),
            attachmentFiles: AttachmentFiles(root: AttachmentFiles.defaultRoot()),
            downloadsRoot: AttachmentDownloader.defaultRoot(),
            thumbnails: AttachmentThumbnails(environment: .current, token: { keychain.authToken }, live: true)
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
        // The queue is this account's: another account's leftovers are wiped before anything shows.
        if let user = session.currentUser?.id { await delivery.adopt(user) }
        // After every sign-in and every launch with a live session (`push.md` §2).
        async let push: Void = pushTokens.sessionDidAuthenticate()
        await loadAllData()
        await push
        _ = await delivery.flushInBackground()
    }

    func sessionDidResume() async {
        await loadAllData()
        await chats.reloadLoaded()
    }

    func sessionWillSignOut() async throws {
        try await delivery.discardForSignOut()
        LocalSendTimes.removeAll()
    }

    func sessionSignOutAborted() async {
        if let user = session.currentUser?.id { await delivery.adopt(user) }
    }

    func sessionDidDiscardAccount() async {
        // Each part is deleted on its own; what fails is retried (the engine blocks and retries its
        // store, the upload queue retries its rows), so nothing of the gone account is kept.
        await delivery.discardAccount()
        LocalSendTimes.removeAll()
    }

    /// Starts watching the device's network (the app, not unit tests).
    func startNetworkWatcher() {
        networkPath.start { [weak self] in
            Task { await self?.networkBecameAvailable() }
        }
    }

    /// The app came to the foreground: what waits goes out (over HTTP until the socket is up).
    func appBecameActive() async {
        // Without a network an HTTP attempt only spends the message's retry budget (§7.3).
        guard session.isAuthenticated, networkPath.isAvailable != false else { return }
        await delivery.appBecameActive()
    }

    /// The device has a network again.
    func networkBecameAvailable() async {
        guard session.isAuthenticated else { return }
        await delivery.networkBecameAvailable()
    }

    func sessionDidEnd() async {
        pushTokens.sessionDidEnd()
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
        // Colleagues' photos and downloaded attachments belong to the session that saw them.
        await avatars.removeAll()
        await thumbnails.removeAll()
        do {
            try await downloads.removeAll()
        } catch {
            Log.delivery.error("Downloaded attachments could not be deleted: \(error.localizedDescription, privacy: .public)")
        }
        // The unsent messages stay: they belong to the account and go out when it is back
        // (an explicit sign-out has deleted them already, with the user's consent).
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
