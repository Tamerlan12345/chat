#if DEBUG
import Foundation
import SwiftUI

/// Mock repositories for `#Preview` and the design gallery: canned colleagues, dialogs, channels
/// and an announcement; nothing ever leaves the process (the server is `preview.invalid`).
enum PreviewData {
    static let me = User(
        id: 1,
        username: "alice",
        fullName: "Алиса Тестова",
        email: "alice@example.test",
        phone: "+7 701 000 00 01",
        jobTitle: "Ведущий аналитик",
        departmentId: 3,
        departmentName: "ИТ",
        status: .online
    )

    static let colleagues: [PublicUser] = [
        PublicUser(id: 2, username: "bob", fullName: "Боб Тестов", email: "bob@example.test", phone: "+7 701 000 00 02", jobTitle: "Инженер", departmentId: 3, departmentName: "ИТ", extension: "214", status: .online),
        PublicUser(id: 3, username: "karina", fullName: "Карина Смирнова", jobTitle: "Бухгалтер", departmentId: 2, departmentName: "Бухгалтерия", extension: "118", status: .away),
        PublicUser(id: 4, username: "daniyar", fullName: "Данияр Нурпеисов", jobTitle: "Юрист", departmentId: 4, departmentName: "Филиал", status: .offline, lastSeen: Date().addingTimeInterval(-3_600)),
        PublicUser(id: 5, username: "elena", fullName: "Елена Ким", jobTitle: "Руководитель отдела продаж", departmentId: 4, departmentName: "Филиал", extension: "301", status: .dnd),
    ]

    static let tree = OrgTree(tree: [
        OrgDepartment(id: 1, name: "Головной офис", subDepartments: [
            OrgDepartment(id: 2, name: "Бухгалтерия"),
            OrgDepartment(id: 3, name: "ИТ"),
        ]),
        OrgDepartment(id: 4, name: "Филиал"),
    ])

    static var directs: [DirectConversation] {
        [
            DirectConversation(userId: 2, fullName: "Боб Тестов", status: .online, lastMessageText: "Привет, Алиса! Всё работает.", lastMessageTime: Date().addingTimeInterval(-600), unreadCount: 2),
            DirectConversation(userId: 3, fullName: "Карина Смирнова", status: .away, lastMessageText: "Счёт отправила на почту", lastMessageTime: Date().addingTimeInterval(-86_400)),
            DirectConversation(userId: 4, fullName: "Данияр Нурпеисов", status: .offline, lastMessageText: "Договор согласован, подпишите, пожалуйста, до пятницы", lastMessageTime: Date().addingTimeInterval(-3 * 86_400)),
        ]
    }

    static var channels: [Channel] {
        [
            Channel(id: 10, name: "mobile-dev", topic: "Канал для разработки мобильных клиентов", unreadCount: 5, lastMessageText: "Сборка зелёная", lastMessageTime: Date().addingTimeInterval(-1_200)),
            Channel(id: 11, name: "общий", type: .private, lastMessageText: "Совещание в 15:00", lastMessageTime: Date().addingTimeInterval(-7_200)),
        ]
    }

    static var announcements: [Announcement] {
        [
            Announcement(id: 1, authorId: 9, title: "Обновление регламента командировок", content: "С 1 ноября авансовые отчёты подаются через систему в течение трёх рабочих дней после возвращения.", priority: .urgent, authorName: "Администратор"),
            Announcement(id: 2, authorId: 9, title: "Тестовое оповещение", content: "Это объявление создано сидированием dev-стенда.", authorName: "Администратор", isConfirmed: true),
        ]
    }

    /// One bubble of each kind for the gallery and the chat preview.
    static func messages() -> [Message] {
        let now = Date()
        func at(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        var list = [
            Message(id: 1, conversationType: .direct, targetId: 1, senderId: 2, text: "Привет, Алиса! Всё работает.", createdAt: at(30), senderName: "Боб Тестов"),
            Message(id: 2, conversationType: .direct, targetId: 1, senderId: 2, text: "Посмотришь отчёт до обеда?", createdAt: at(29), senderName: "Боб Тестов"),
            Message(id: 3, conversationType: .direct, targetId: 2, senderId: 1, text: "Да, уже открыла.", createdAt: at(20), senderName: "Алиса Тестова", deliveryStatus: .read),
            Message(id: 4, conversationType: .direct, targetId: 2, senderId: 1, text: "Отправила правки.", createdAt: at(12), senderName: "Алиса Тестова", deliveryStatus: .delivered),
            Message(id: 5, conversationType: .direct, targetId: 2, senderId: 1, text: "И таблицу тоже.", createdAt: at(11), senderName: "Алиса Тестова", deliveryStatus: .sent),
            Message(id: -6, conversationType: .direct, targetId: 2, senderId: 1, text: "Это ушло, пока не было сети", createdAt: at(2), senderName: "Алиса Тестова", sendState: .queued),
            Message(id: -7, conversationType: .direct, targetId: 2, senderId: 1, text: "А это прямо сейчас отправляется", createdAt: at(1), senderName: "Алиса Тестова", sendState: .sending),
            Message(id: -8, conversationType: .direct, targetId: 2, senderId: 1, text: "Сервер не принял это сообщение", createdAt: at(0.5), senderName: "Алиса Тестова", sendState: .failed),
        ]
        list[7].failureReason = String(localized: "Сервер не ответил")
        let file = Message(
            id: 9,
            conversationType: .direct,
            targetId: 1,
            senderId: 2,
            text: "Регламент.pdf",
            type: .file,
            metadataJson: #"{"file_id":901,"file_name":"Регламент.pdf","mime_type":"application/pdf","size":482133}"#,
            createdAt: at(40),
            senderName: "Боб Тестов"
        )
        var reply = Message(id: 10, conversationType: .direct, targetId: 2, senderId: 1, text: "Спасибо, прочитала.", replyToId: 9, createdAt: at(39), senderName: "Алиса Тестова", deliveryStatus: .read)
        reply.replyQuote = ReplyQuote(senderName: "Боб Тестов", text: "Регламент.pdf")
        return [file, reply] + list
    }
}

/// The server of the previews: always healthy, never reached over the network.
struct PreviewServerRepository: ServerRepository {
    func checkHealth() async throws -> HealthResponse { HealthResponse(status: "ok", error: nil) }
    func fetchServerInfo() async throws -> ServerInfo { ServerInfo() }
}

struct PreviewAuthRepository: AuthRepository {
    var hasStoredToken: Bool { false }
    var hasDeviceSecret: Bool { false }
    var savedUsername: String? { "alice" }
    func bindStoredCredentials(to origin: String) throws -> StoredCredentialDecision { .nothingStored }
    func login(username: String, password: String) async throws -> AuthSuccessResponse { throw APIError.noConnection }
    func claimDevice() async {}
    func knock(device: DeviceDescriptor) async throws -> KnockResponse { throw APIError.noConnection }
    func currentUser() async throws -> User { PreviewData.me }
    func changePassword(oldPassword: String, newPassword: String) async throws -> ChangePasswordResponse { throw APIError.noConnection }
    func logout() async throws {}
    func clearSession() throws {}
}

struct PreviewChatRepository: ChatRepository {
    func directConversations() async throws -> [DirectConversation] { PreviewData.directs }
    func channels() async throws -> [Channel] { PreviewData.channels }
    func users() async throws -> [PublicUser] { PreviewData.colleagues }
    func createChannel(name: String, topic: String?, type: ChannelType) async throws -> Channel { throw APIError.noConnection }
    func messages(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [Message] { [] }
    func messages(in conversation: ConversationKey, limit: Int, afterId: Int64) async throws -> [Message] { [] }
    func searchMessages(_ query: String) async throws -> [Message] { [] }
    func uploadFile(data: Data, fileName: String, mimeType: String) async throws -> FileUploadResponse { throw APIError.noConnection }
    func messageRecords(in conversation: ConversationKey, limit: Int, beforeId: Int64?) async throws -> [JSONObject] { [] }
    func messageRecords(in conversation: ConversationKey, limit: Int, afterId: Int64) async throws -> [JSONObject] { [] }
    func filePolicy() async throws -> FilePolicyEffectiveResponse { FilePolicyEffectiveResponse() }
}

struct PreviewAnnouncementsRepository: AnnouncementsRepository {
    func announcements() async throws -> [Announcement] { PreviewData.announcements }
    func acknowledge(id: Int64) async throws -> AnnouncementAckResponse { throw APIError.noConnection }
}

struct PreviewRealtimeRepository: RealtimeRepository {
    func connect() async {}
    func disconnect() async {}
    func send(_ message: WSClientMessage) async {}
    func sendIfAuthenticated(_ message: WSClientMessage) async -> Bool { false }
    func sendAudioFrame(_ frame: Data) async {}
    func events() async -> AsyncStream<WSServerEvent> { AsyncStream { $0.finish() } }
    func incomingAudio() async -> AsyncStream<AudioRelayEngine.DecodedAudioFrame> { AsyncStream { $0.finish() } }
    func connectionStates() async -> AsyncStream<RealtimeConnectionState> { AsyncStream { $0.finish() } }
    func deliveryFrames() async -> AsyncStream<DeliveryLinkFrame> { AsyncStream { $0.finish() } }
    func sendFrame(_ frame: JSONObject) async -> Bool { false }
    func restartLink() async {}
    func reconnectNow() async {}
    func authenticatedUserId() async -> Int64? { nil }
}

@MainActor
final class PreviewPeopleSource: PeopleSource {
    func users() async throws -> [PublicUser] { PreviewData.colleagues }
    func orgTree() async throws -> OrgTree { PreviewData.tree }
    func user(id: Int64) async throws -> PublicUser {
        guard let user = PreviewData.colleagues.first(where: { $0.id == id }) else { throw APIError.noConnection }
        return user
    }
}

extension AppContainer {
    /// A container with canned data, signed in as Alice (previews and the design gallery).
    static func preview(signedIn: Bool = true) -> AppContainer {
        let container = AppContainer(
            server: PreviewServerRepository(),
            auth: PreviewAuthRepository(),
            chat: PreviewChatRepository(),
            announcements: PreviewAnnouncementsRepository(),
            realtime: PreviewRealtimeRepository(),
            environment: ServerEnvironment(validating: "https://preview.invalid")!,
            peopleSource: PreviewPeopleSource()
        )
        if signedIn {
            container.session.currentUser = PreviewData.me
            container.conversations.directConversations = PreviewData.directs
            container.conversations.channels = PreviewData.channels
            container.conversations.users = PreviewData.colleagues
            container.announcements.announcements = PreviewData.announcements
        }
        return container
    }
}

extension View {
    /// The preview container and every store in the environment.
    func previewEnvironment(_ container: AppContainer = .preview()) -> some View {
        appEnvironment(container)
            .environment(AppNavigation())
            .environment(PeopleRequests())
            .environment(NavigationRouter())
    }
}
#endif
