package com.openmychat.mobile.core.network

import com.openmychat.mobile.data.model.ConversationType
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Кадр auth и кадр viewing (multi-device.md §3, §4). */
class AuthFrameTest {

    @Test
    fun foregroundAuthCarriesDeviceIdPlatformAndTheOpenChat() {
        val frame = WebSocketClient.authFrame(
            "jwt",
            "2b1f0c6e-1d2a-4f3b-9c8d-7e6f5a4b3c2d",
            AuthContext.Snapshot(background = false, viewing = ConversationType.CHANNEL to 7L)
        )
        assertEquals("auth", frame["type"]!!.jsonPrimitive.content)
        assertEquals("2b1f0c6e-1d2a-4f3b-9c8d-7e6f5a4b3c2d", frame["device_id"]!!.jsonPrimitive.content)
        assertEquals("android", frame["platform"]!!.jsonPrimitive.content)
        assertFalse("на переднем плане presence не передаётся (по умолчанию online)", "presence" in frame)
        val viewing = frame["viewing"]!!.jsonObject
        assertEquals("channel", viewing["conversationType"]!!.jsonPrimitive.content)
        assertEquals(7L, viewing["targetId"]!!.jsonPrimitive.content.toLong())
    }

    @Test
    fun backgroundAuthIsAwayWithoutViewing() {
        val frame = WebSocketClient.authFrame("jwt", "dev-1", AuthContext.Snapshot(background = true, viewing = null))
        assertEquals("away", frame["presence"]!!.jsonPrimitive.content)
        assertFalse("viewing" in frame)
    }

    @Test
    fun aDeviceIdOutsideTheContractFormatIsNotSent() {
        val frame = WebSocketClient.authFrame("jwt", "bad id with spaces", AuthContext.Snapshot(false, null))
        assertFalse("device_id" in frame)
        assertEquals("android", frame["platform"]!!.jsonPrimitive.content)
    }

    @Test
    fun viewingFrames() {
        val open = WebSocketClient.viewingFrame(ConversationType.DIRECT, 5)
        assertEquals("viewing", open["type"]!!.jsonPrimitive.content)
        assertEquals("direct", open["conversationType"]!!.jsonPrimitive.content)
        assertEquals(5L, open["targetId"]!!.jsonPrimitive.content.toLong())
        val none = WebSocketClient.viewingFrame(null, null)
        assertEquals(JsonNull, none["conversationType"])
        assertFalse("targetId" in none)
    }

    @Test
    fun backgroundSnapshotDropsViewing() {
        val context = AuthContext()
        context.update(background = true, viewing = ConversationType.DIRECT to 5L)
        assertEquals(null, context.snapshot().viewing)
    }
}
