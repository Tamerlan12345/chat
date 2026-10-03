package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.ui.components.MessageAction

/**
 * What the long-press menu offers for a message, in the brief's order (Ответить, Копировать,
 * Изменить, Удалить). Edit and delete follow the server's rules ([canEdit], [canDelete]); a failed
 * send can only be copied or discarded; a deleted message offers nothing.
 */
object MessageMenuPolicy {
    fun actionsFor(message: Message, canEdit: Boolean, canDelete: Boolean, failed: Boolean): List<MessageAction> {
        if (message.isDeleted) return emptyList()
        return buildList {
            if (!failed) add(MessageAction.REPLY)
            if (message.type == MessageType.TEXT && message.text.isNotBlank()) add(MessageAction.COPY)
            if (canEdit && !failed) add(MessageAction.EDIT)
            if (canDelete || failed) add(MessageAction.DELETE)
        }
    }
}
