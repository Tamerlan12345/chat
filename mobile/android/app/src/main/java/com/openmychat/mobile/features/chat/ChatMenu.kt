package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.ui.components.MessageAction

/**
 * What the long-press menu offers for a message, in the brief's order (Ответить, Копировать,
 * Редактировать, Удалить, Пожаловаться). Edit and delete follow the server's rules ([canEdit], [canDelete]); a failed
 * send can only be copied or discarded; a deleted message offers nothing.
 */
object MessageMenuPolicy {
    fun actionsFor(
        message: Message,
        canEdit: Boolean,
        canDelete: Boolean,
        failed: Boolean,
        /** Someone else's delivered message: «Пожаловаться» comes last, apart from editing. */
        canReport: Boolean = false,
        /** An own message still in the queue (queued or sending): it can only be copied or cancelled. */
        unsent: Boolean = false
    ): List<MessageAction> {
        if (message.isDeleted) return emptyList()
        val settled = !failed && !unsent
        return buildList {
            if (settled) add(MessageAction.REPLY)
            if (message.type == MessageType.TEXT && message.text.isNotBlank()) add(MessageAction.COPY)
            if (canEdit && settled) add(MessageAction.EDIT)
            if (canDelete || failed || unsent) add(MessageAction.DELETE)
            if (canReport && settled) add(MessageAction.REPORT)
        }
    }
}
