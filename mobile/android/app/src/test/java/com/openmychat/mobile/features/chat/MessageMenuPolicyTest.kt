package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.ui.components.MessageAction
import com.openmychat.mobile.ui.components.MessageAction.COPY
import com.openmychat.mobile.ui.components.MessageAction.DELETE
import com.openmychat.mobile.ui.components.MessageAction.EDIT
import com.openmychat.mobile.ui.components.MessageAction.REPLY
import org.junit.Assert.assertEquals
import org.junit.Test

/** The long-press menu offers only what the server would accept, in the brief's order. */
class MessageMenuPolicyTest {

    private fun msg(text: String = "Привет", type: MessageType = MessageType.TEXT, deleted: Boolean = false) = Message(
        id = 1, conversationType = ConversationType.DIRECT, targetId = 2, senderId = 1, text = text,
        type = type, createdAt = "2026-10-02T09:00:00.000Z", isDeleted = deleted
    )

    private fun actions(m: Message, canEdit: Boolean = false, canDelete: Boolean = false, failed: Boolean = false, canReport: Boolean = false): List<MessageAction> =
        MessageMenuPolicy.actionsFor(m, canEdit = canEdit, canDelete = canDelete, failed = failed, canReport = canReport)

    @Test
    fun anOwnEditableMessageOffersAllFourInOrder() {
        assertEquals(listOf(REPLY, COPY, EDIT, DELETE), actions(msg(), canEdit = true, canDelete = true))
    }

    @Test
    fun someoneElsesMessageCanBeAnsweredAndCopied() {
        assertEquals(listOf(REPLY, COPY), actions(msg()))
    }

    @Test
    fun aFileHasNoTextToCopy() {
        assertEquals(listOf(REPLY), actions(msg(text = "отчёт.pdf", type = MessageType.FILE)))
    }

    @Test
    fun aDeletedMessageOffersNothing() {
        assertEquals(emptyList<MessageAction>(), actions(msg(deleted = true), canEdit = true, canDelete = true))
    }

    @Test
    fun aFailedSendCanBeCopiedOrDiscardedButNotAnsweredOrEdited() {
        assertEquals(listOf(COPY, DELETE), actions(msg(), canEdit = true, canDelete = false, failed = true))
    }

    @Test
    fun blankTextIsNotCopied() {
        assertEquals(listOf(REPLY), actions(msg(text = "   ")))
    }

    @Test
    fun someoneElsesMessageCanBeReportedLast() {
        assertEquals(listOf(REPLY, COPY, MessageAction.REPORT), actions(msg(), canReport = true))
        assertEquals(listOf(REPLY, MessageAction.REPORT), actions(msg(text = "отчёт.pdf", type = MessageType.FILE), canReport = true))
        assertEquals("a deleted message offers nothing", emptyList<MessageAction>(), actions(msg(deleted = true), canReport = true))
    }
}
