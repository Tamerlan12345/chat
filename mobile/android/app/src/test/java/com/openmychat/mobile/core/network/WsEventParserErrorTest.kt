package com.openmychat.mobile.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** `error` frames carry a machine `code` (server/src/ws/server.js errorFrame); the chat branches on it. */
class WsEventParserErrorTest {

    @Test
    fun aRefusedSendCarriesItsCode() {
        val frame = WsEventParser.parse(
            """{"type":"error","context":"send_message","message":"Сообщение не может быть доставлено","code":"DM_NOT_ALLOWED","retryable":false,"text":"привет","client_msg_id":"k-1"}"""
        )

        val error = (frame as WsFrame.Event).event as WsEvent.GenericError
        assertEquals("DM_NOT_ALLOWED", error.code)
        assertEquals("send_message", error.context)
        assertEquals("k-1", error.clientMsgId)
    }

    @Test
    fun anOlderServerSendsNoCode() {
        val frame = WsEventParser.parse("""{"type":"error","message":"Ошибка обработки запроса"}""")

        assertNull(((frame as WsFrame.Event).event as WsEvent.GenericError).code)
    }
}
