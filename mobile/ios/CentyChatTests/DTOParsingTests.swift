import XCTest
@testable import CentyChat

final class DTOParsingTests: XCTestCase {
    
    func testUserParsing() throws {
        let json = """
        {
            "id": 7,
            "username": "k.akhmetov",
            "full_name": "Ахметов Канат",
            "email": "k.akhmetov@cic.kz",
            "phone": "+7 (727) 250-00-11",
            "job_title": "Ведущий разработчик",
            "department_id": 3,
            "department_name": "Отдел мобильной разработки",
            "role_id": 2,
            "role_name": "Сотрудник",
            "permissions": {
                "is_admin": false,
                "can_call": true,
                "can_create_channels": true,
                "can_upload_files": true
            },
            "uin": 1042,
            "extension": "142",
            "company": "АО СК «Сентрас Иншуранс»",
            "status": "online",
            "custom_status": "Работа над iOS",
            "last_seen": "2026-09-30T09:15:22.000Z",
            "is_active": 1,
            "must_change_password": 0,
            "approval_status": "approved",
            "created_at": "2025-01-10T08:00:00.000Z"
        }
        """.data(using: .utf8)!
        
        let user = try JSONDecoder().decode(User.self, from: json)
        
        XCTAssertEqual(user.id, 7)
        XCTAssertEqual(user.username, "k.akhmetov")
        XCTAssertEqual(user.fullName, "Ахметов Канат")
        XCTAssertEqual(user.status, .online)
        XCTAssertTrue(user.isActive)
        XCTAssertFalse(user.mustChangePassword)
        XCTAssertEqual(user.permissions?.canCall, true)
        XCTAssertEqual(user.permissions?.canCreateChannels, true)
        XCTAssertEqual(user.uin, 1042)
    }
    
    func testChannelParsing() throws {
        let json = """
        {
            "id": 1,
            "name": "#Общий",
            "topic": "Главный канал компании",
            "type": "public",
            "owner_id": 1,
            "created_at": "2025-01-01T00:00:00.000Z",
            "member_role": "member",
            "members_count": 180,
            "unread_count": 5,
            "last_message_text": "Всем доброе утро!",
            "last_message_time": "2026-09-30T09:00:00.000Z"
        }
        """.data(using: .utf8)!
        
        let channel = try JSONDecoder().decode(Channel.self, from: json)
        
        XCTAssertEqual(channel.id, 1)
        XCTAssertEqual(channel.name, "#Общий")
        XCTAssertEqual(channel.type, .public)
        XCTAssertEqual(channel.membersCount, 180)
        XCTAssertEqual(channel.unreadCount, 5)
        XCTAssertEqual(channel.lastMessageText, "Всем доброе утро!")
    }
    
    func testMessageParsingWithMetadata() throws {
        let json = """
        {
            "id": 240,
            "conversation_type": "direct",
            "target_id": 12,
            "sender_id": 7,
            "text": "Привет! Отправил спецификацию",
            "type": "file",
            "reply_to_id": null,
            "metadata_json": "{\\"file_id\\": 42, \\"file_name\\": \\"spec.pdf\\", \\"size\\": 1048576}",
            "created_at": "2026-09-30T09:20:15.000Z",
            "updated_at": null,
            "is_deleted": 0,
            "sender_username": "k.akhmetov",
            "sender_name": "Ахметов Канат",
            "file_original_name": "spec.pdf",
            "delivery_status": "read"
        }
        """.data(using: .utf8)!
        
        let message = try JSONDecoder().decode(Message.self, from: json)
        
        XCTAssertEqual(message.id, 240)
        XCTAssertEqual(message.conversationType, .direct)
        XCTAssertEqual(message.targetId, 12)
        XCTAssertEqual(message.senderId, 7)
        XCTAssertEqual(message.type, .file)
        XCTAssertFalse(message.isDeleted)
        XCTAssertEqual(message.deliveryStatus, .read)
        XCTAssertEqual(message.metadata?.fileId, 42)
        XCTAssertEqual(message.metadata?.fileName, "spec.pdf")
        XCTAssertEqual(message.metadata?.fileSize, 1048576)
    }
    
    func testAnnouncementParsing() throws {
        let json = """
        {
            "id": 3,
            "author_id": 1,
            "title": "Плановые работы",
            "content": "Обновление серверной инфраструктуры",
            "target_type": "all",
            "priority": "urgent",
            "created_at": "2026-09-30T08:00:00.000Z",
            "author_name": "Главный Администратор",
            "confirmed_at": null,
            "is_confirmed": 0
        }
        """.data(using: .utf8)!
        
        let announcement = try JSONDecoder().decode(Announcement.self, from: json)
        
        XCTAssertEqual(announcement.id, 3)
        XCTAssertEqual(announcement.title, "Плановые работы")
        XCTAssertEqual(announcement.priority, .urgent)
        XCTAssertFalse(announcement.isConfirmed)
        XCTAssertNil(announcement.confirmedAt)
    }
    
    func testWebSocketEventParsing() throws {
        let rawWsJson = """
        {
            "type": "wake_ring",
            "fromUserId": 12,
            "fromName": "Данияр Нурпеисов",
            "at": 1759230000000
        }
        """.data(using: .utf8)!
        
        let event = WSServerEvent.parse(from: rawWsJson)
        
        guard case .wakeRing(let fromId, let fromName, let at) = event else {
            XCTFail("Failed to parse wake_ring event")
            return
        }
        
        XCTAssertEqual(fromId, 12)
        XCTAssertEqual(fromName, "Данияр Нурпеисов")
        XCTAssertEqual(at, 1759230000000)
    }
}
