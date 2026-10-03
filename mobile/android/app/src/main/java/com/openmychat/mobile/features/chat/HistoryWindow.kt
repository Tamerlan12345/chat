package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.Message

/**
 * Переход к найденному сообщению: история вокруг него, непрерывная до последнего сообщения, чтобы
 * новые сообщения по WebSocket продолжали её без дыры. `beforeId = id + 1` берёт само сообщение и
 * [BEFORE] более ранних; более новые догружаются страницами `afterId`. Если новых больше
 * [PAGE] × [MAX_PAGES], окно не собирается (null): чат откроется на последних сообщениях.
 */
object HistoryWindow {
    const val BEFORE = 30
    const val PAGE = 200
    const val MAX_PAGES = 5

    suspend fun around(
        messageId: Long,
        before: suspend (beforeId: Long, limit: Int) -> List<Message>,
        after: suspend (afterId: Long, limit: Int) -> List<Message>
    ): List<Message>? {
        val older = before(messageId + 1, BEFORE + 1)
        if (older.none { it.id == messageId }) return null
        val newer = ArrayList<Message>()
        var cursor = messageId
        repeat(MAX_PAGES) {
            val page = after(cursor, PAGE)
            newer += page
            if (page.size < PAGE) return (older + newer).distinctBy { it.id }.sortedBy { it.id }
            cursor = page.maxOf { it.id }
        }
        return null
    }
}
