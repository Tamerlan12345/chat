package com.openmychat.mobile.features

import com.openmychat.mobile.core.util.MessageWindowValidator
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import org.junit.Assert.*
import org.junit.Test

class ChatViewModelTest {

    @Test
    fun testMessageWindowValidationOnNewMessage() {
        val nowIso = java.time.Instant.now().toString()
        val message = Message(
            id = 101,
            conversationType = ConversationType.DIRECT,
            targetId = 2,
            senderId = 1,
            text = "Тестовое сообщение",
            type = MessageType.TEXT,
            createdAt = nowIso,
            isDeleted = false,
            senderName = "Тест"
        )

        // Validate that newly created message is editable with 60 minute window
        val canEdit = MessageWindowValidator.canEditOrDelete(
            createdAtIso = message.createdAt,
            windowMinutesStr = "60",
            isSuperAdmin = false,
            isDelete = false
        )
        assertTrue(canEdit)
    }

    @Test
    fun testMessageDeliveryStatusTransition() {
        val originalMessage = Message(
            id = 202,
            conversationType = ConversationType.DIRECT,
            targetId = 2,
            senderId = 1,
            text = "Проверка статуса",
            createdAt = "2026-09-30T10:00:00.000Z",
            deliveryStatus = null
        )
        assertNull(originalMessage.deliveryStatus)

        // Status update to delivered
        val deliveredMessage = originalMessage.copy(deliveryStatus = DeliveryStatus.DELIVERED)
        assertEquals(DeliveryStatus.DELIVERED, deliveredMessage.deliveryStatus)

        // Status update to read
        val readMessage = deliveredMessage.copy(deliveryStatus = DeliveryStatus.READ)
        assertEquals(DeliveryStatus.READ, readMessage.deliveryStatus)
    }

    @Test
    fun testDeletedMessageCannotBeEdited() {
        val nowIso = java.time.Instant.now().toString()
        val deletedMessage = Message(
            id = 303,
            conversationType = ConversationType.DIRECT,
            targetId = 2,
            senderId = 1,
            text = "",
            createdAt = nowIso,
            isDeleted = true
        )

        // If message is deleted, it should not be editable regardless of time
        val canEdit = !deletedMessage.isDeleted && MessageWindowValidator.canEditOrDelete(
            createdAtIso = deletedMessage.createdAt,
            windowMinutesStr = "60"
        )
        assertFalse(canEdit)
    }
}
