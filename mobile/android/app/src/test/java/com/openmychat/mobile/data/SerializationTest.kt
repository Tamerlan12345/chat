package com.openmychat.mobile.data

import com.openmychat.mobile.data.model.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class SerializationTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    @Test
    fun testUserDeserializationWithNumericBooleans() {
        val userJson = """
            {
                "id": 7,
                "username": "k.akhmetov",
                "full_name": "Канат Ахметов",
                "email": "k.akhmetov@centras.kz",
                "job_title": "Android Lead",
                "department_name": "Отдел мобильной разработки",
                "status": "online",
                "is_active": 1,
                "must_change_password": 0,
                "approval_status": "approved",
                "created_at": "2026-09-30T08:00:00.000Z"
            }
        """.trimIndent()

        val user = json.decodeFromString<User>(userJson)

        assertEquals(7L, user.id)
        assertEquals("k.akhmetov", user.username)
        assertEquals("Канат Ахметов", user.fullName)
        assertEquals(UserStatus.ONLINE, user.status)
        assertTrue(user.isActive)
        assertFalse(user.mustChangePassword)
    }

    @Test
    fun testUserDeserializationWithStandardBooleans() {
        val userJson = """
            {
                "id": 12,
                "username": "d.nurpeisov",
                "full_name": "Данияр Нурпеисов",
                "status": "dnd",
                "is_active": true,
                "must_change_password": true,
                "created_at": "2026-09-30T09:00:00.000Z"
            }
        """.trimIndent()

        val user = json.decodeFromString<User>(userJson)

        assertEquals(12L, user.id)
        assertEquals(UserStatus.DND, user.status)
        assertTrue(user.isActive)
        assertTrue(user.mustChangePassword)
    }

    @Test
    fun testMessageDeserializationWithMetadataAndIsDeleted() {
        val messageJson = """
            {
                "id": 512,
                "conversation_type": "direct",
                "target_id": 12,
                "sender_id": 7,
                "text": "Отправил обновленные контракты",
                "type": "text",
                "reply_to_id": 100,
                "is_deleted": 0,
                "created_at": "2026-09-30T09:40:00.000Z",
                "sender_username": "k.akhmetov",
                "sender_name": "Канат Ахметов",
                "delivery_status": "delivered",
                "metadata": {
                    "file_id": 42,
                    "file_name": "spec.pdf"
                }
            }
        """.trimIndent()

        val message = json.decodeFromString<Message>(messageJson)

        assertEquals(512L, message.id)
        assertEquals(ConversationType.DIRECT, message.conversationType)
        assertEquals(12L, message.targetId)
        assertEquals(7L, message.senderId)
        assertEquals("Отправил обновленные контракты", message.text)
        assertEquals(MessageType.TEXT, message.type)
        assertEquals(100L, message.replyToId)
        assertFalse(message.isDeleted)
        assertEquals(DeliveryStatus.DELIVERED, message.deliveryStatus)
        assertEquals(42L, message.metadata?.fileId)
        assertEquals("spec.pdf", message.metadata?.fileName)
    }

    @Test
    fun testChannelDeserialization() {
        val channelJson = """
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
                "last_message_text": "Всем доброго дня!"
            }
        """.trimIndent()

        val channel = json.decodeFromString<Channel>(channelJson)

        assertEquals(1L, channel.id)
        assertEquals("#Общий", channel.name)
        assertEquals(ChannelType.PUBLIC, channel.type)
        assertEquals(180, channel.membersCount)
        assertEquals(5, channel.unreadCount)
        assertEquals("Всем доброго дня!", channel.lastMessageText)
    }

    @Test
    fun testAnnouncementDeserializationWithUrgentPriority() {
        val annJson = """
            {
                "id": 4,
                "author_id": 1,
                "title": "Срочное обновление",
                "content": "Установить мобильное приложение v1.0",
                "target_type": "all",
                "priority": "critical",
                "created_at": "2026-09-30T09:50:00.000Z",
                "author_name": "Администратор",
                "is_confirmed": 0
            }
        """.trimIndent()

        val announcement = json.decodeFromString<Announcement>(annJson)

        assertEquals(4L, announcement.id)
        assertEquals(AnnouncementPriority.CRITICAL, announcement.priority)
        assertEquals(AnnouncementTarget.ALL, announcement.targetType)
        assertFalse(announcement.isConfirmed)
    }

    @Test
    fun testDirectConversationDeserialization() {
        val convJson = """
            {
                "user_id": 12,
                "username": "d.nurpeisov",
                "full_name": "Данияр Нурпеисов",
                "status": "away",
                "job_title": "Android Lead",
                "department_name": "Отдел разработки",
                "last_message_text": "Привет!",
                "unread_count": 2
            }
        """.trimIndent()

        val conversation = json.decodeFromString<DirectConversation>(convJson)

        assertEquals(12L, conversation.userId)
        assertEquals("d.nurpeisov", conversation.username)
        assertEquals(UserStatus.AWAY, conversation.status)
        assertEquals(2, conversation.unreadCount)
    }

    @Test
    fun testServerInfoSerialization() {
        val info = ServerInfo(
            serverName = "CentyChat Production",
            companyName = "АО СК «Сентрас Иншуранс»",
            allowRegistration = false,
            messageEditWindowMinutes = "30",
            messageDeleteWindowMinutes = "60",
            version = "1.0.0"
        )

        val encoded = json.encodeToString(info)
        val decoded = json.decodeFromString<ServerInfo>(encoded)

        assertEquals("30", decoded.messageEditWindowMinutes)
        assertEquals("60", decoded.messageDeleteWindowMinutes)
        assertEquals("CentyChat Production", decoded.serverName)
    }

    @Test
    fun testFileUploadResponseCamelCaseDeserialization() {
        val fileJson = """
            {
                "id": "42",
                "originalName": "contract_draft.pdf",
                "storedFilename": "1789385160210_57cb49677b85dae3.pdf",
                "fileSize": 1048576,
                "mimeType": "application/pdf",
                "url": "/api/files/download/42"
            }
        """.trimIndent()

        val resp = json.decodeFromString<FileUploadResponse>(fileJson)

        assertEquals("42", resp.id)
        assertEquals("contract_draft.pdf", resp.originalName)
        assertEquals("1789385160210_57cb49677b85dae3.pdf", resp.storedFilename)
        assertEquals(1048576L, resp.fileSize)
        assertEquals("application/pdf", resp.mimeType)
        assertEquals("/api/files/download/42", resp.url)
    }

    @Test
    fun testFilePolicyExtensionValidation() {
        val policy = FilePolicy(
            enabled = true,
            allowed = listOf("pdf", "png", "docx")
        )

        assertTrue(policy.isExtensionAllowed("pdf"))
        assertTrue(policy.isExtensionAllowed(".PNG"))
        assertTrue(policy.isExtensionAllowed("docx"))
        assertFalse(policy.isExtensionAllowed("exe"))
        assertFalse(policy.isExtensionAllowed("bat"))
        assertFalse(policy.isExtensionAllowed(""))

        val disabledPolicy = FilePolicy(enabled = false, allowed = emptyList())
        assertTrue(disabledPolicy.isExtensionAllowed("exe"))
    }

    @Test
    fun testRolePermissionsAdminFlags() {
        val permJson = """
            {
                "is_admin": 1,
                "is_scoped_admin": 0,
                "can_delete_all_messages": 1
            }
        """.trimIndent()

        val perms = json.decodeFromString<RolePermissions>(permJson)

        assertTrue(perms.isAdmin)
        assertTrue(perms.is_admin)
        assertFalse(perms.isScopedAdmin)
        assertFalse(perms.is_scoped_admin)
        assertTrue(perms.canDeleteAllMessages)
    }
}

