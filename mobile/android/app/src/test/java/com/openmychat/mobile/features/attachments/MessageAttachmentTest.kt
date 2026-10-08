package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A file or image message as the server sends it (metadata_json, file_original_name, file_width). */
class MessageAttachmentTest {

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    private fun msg(
        text: String = "отчёт.pdf",
        type: MessageType = MessageType.FILE,
        metadataJson: String? = """{"file_id":42}""",
        originalName: String? = null,
        deleted: Boolean = false
    ) = Message(
        id = 1, conversationType = ConversationType.CHANNEL, targetId = 3, senderId = 2, text = text, type = type,
        metadataJson = metadataJson, createdAt = "2026-10-02T09:00:00.000Z", fileOriginalName = originalName, isDeleted = deleted
    )

    @Test
    fun aServerFileMessageNamesItsFileFromTheServerNotTheText() {
        val attachment = Attachments.of(msg(text = "подпись", originalName = "dev-stand-notes.txt"))!!
        assertEquals(42L, attachment.fileId)
        assertEquals("dev-stand-notes.txt", attachment.name)
        assertFalse(attachment.isImage)
    }

    @Test
    fun theDesktopMetadataGivesSizeAndType() {
        val attachment = Attachments.of(
            msg(metadataJson = """{"file_id":"7","size":2048,"mimeType":"application/pdf","url":"/api/files/download/7"}""")
        )!!
        assertEquals(7L, attachment.fileId)
        assertEquals(2048L, attachment.size)
        assertEquals("application/pdf", attachment.mimeType)
        assertEquals("the text is the name when the server has none", "отчёт.pdf", attachment.name)
    }

    @Test
    fun anImageMessageIsAnImageWithTheServersDimensions() {
        val raw = """
            {"id":9,"conversation_type":"direct","target_id":3,"sender_id":2,"text":"schema.png","type":"image",
             "metadata_json":"{\"file_id\":3,\"size\":8333,\"mimeType\":\"image/png\"}","created_at":"2026-10-02T09:00:00.000Z",
             "is_deleted":0,"file_original_name":"schema.png","file_width":640,"file_height":480,"file_dominant_color":"#c83838"}
        """.trimIndent()
        val attachment = Attachments.of(json.decodeFromString<Message>(raw))!!
        assertTrue(attachment.isImage)
        assertEquals(640, attachment.width)
        assertEquals(480, attachment.height)
    }

    @Test
    fun onlyFormatsTheServerCanThumbnailAreImages() {
        assertTrue(Attachments.of(msg(text = "фото.JPG"))!!.isImage)
        assertFalse("svg is never drawn inline", Attachments.of(msg(text = "logo.svg", type = MessageType.IMAGE))!!.isImage)
        assertFalse(Attachments.of(msg(text = "photo.heic", type = MessageType.IMAGE))!!.isImage)
    }

    @Test
    fun textAndDeletedMessagesHaveNoAttachment() {
        assertNull(Attachments.of(msg(type = MessageType.TEXT)))
        assertNull(Attachments.of(msg(deleted = true)))
    }

    @Test
    fun brokenMetadataStillShowsTheFileButCannotOpenIt() {
        val attachment = Attachments.of(msg(metadataJson = "{not json"))!!
        assertNull(attachment.fileId)
        assertEquals("отчёт.pdf", attachment.name)
    }

    @Test
    fun aLocalUploadIsDescribedByThePickedFile() {
        val local = msg(metadataJson = null, type = MessageType.IMAGE, text = "IMG_1.jpg").copy(
            upload = LocalUpload(uri = "content://media/1", name = "IMG_1.jpg", size = 5000, mimeType = "image/jpeg", width = 300, height = 200)
        )
        val attachment = Attachments.of(local)!!
        assertNull("not uploaded yet", attachment.fileId)
        assertEquals("content://media/1", attachment.localUri)
        assertEquals(5000L, attachment.size)
        assertTrue(attachment.isImage)
        assertEquals(300, attachment.width)
    }

    @Test
    fun extensionsFollowTheServersRule() {
        assertEquals("pdf", Attachments.extensionOf("Отчёт.PDF"))
        assertEquals("", Attachments.extensionOf(".bashrc"))
        assertEquals("", Attachments.extensionOf("name."))
        assertEquals("", Attachments.extensionOf("README"))
        assertEquals("gz", Attachments.extensionOf("a.tar.gz"))
    }
}
